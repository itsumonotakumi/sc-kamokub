#!/usr/bin/env python3
"""IPA公開の過去問PDFを取り込んで、スマホ表示用の画像とメタデータを作る。

  python3 scripts/build_pastexams.py            # IPAからダウンロードして生成
  python3 scripts/build_pastexams.py --local DIR # DIR内のPDF（URLと同じファイル名）を使う

出力:
  data/catalog.json            過去問の一覧（問ごとのページ画像・解答例テキスト・解答欄）
  data/past/<examId>/*.webp    ページ画像

必要: poppler-utils（pdftotext, pdftoppm）, Pillow
PDFそのものはリポジトリに含めず、GitHub Actions上で毎回取得する前提。
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = ROOT / ".cache" / "pdf"
DPI = 120

Q_START = re.compile(r"問\s*([1-4])\s*(.{0,80}?)に関する次の記述を読んで")
Q_START_LOOSE = re.compile(r"(?m)^\s*問\s*([1-4])(?![0-9])\s+\S")
ANS_MARK = re.compile(r"(?m)^[ \t]*問[ \t]*([1-4])(?![0-9])")


def nfkc(s: str) -> str:
    return unicodedata.normalize("NFKC", s)


def fetch(url: str, local_dir: Path | None) -> Path:
    name = url.rsplit("/", 1)[-1]
    if local_dir:
        p = local_dir / name
        if not p.exists():
            raise FileNotFoundError(p)
        return p
    CACHE.mkdir(parents=True, exist_ok=True)
    p = CACHE / name
    if p.exists() and p.stat().st_size > 1000:
        return p
    req = urllib.request.Request(url, headers={"User-Agent": "sc-kamokub-builder/1.0"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r, open(p, "wb") as f:
                shutil.copyfileobj(r, f)
            return p
        except Exception as e:  # noqa: BLE001
            if attempt == 2:
                raise
            print(f"  retry {url}: {e}", file=sys.stderr)
            time.sleep(3)
    return p


def page_texts(pdf: Path) -> list[str]:
    out = subprocess.run(["pdftotext", "-enc", "UTF-8", str(pdf), "-"],
                         capture_output=True, check=True).stdout.decode("utf-8", "replace")
    pages = out.split("\f")
    if pages and not pages[-1].strip():
        pages = pages[:-1]
    return [nfkc(p) for p in pages]


def render(pdf: Path, outdir: Path, prefix: str) -> list[str]:
    outdir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        subprocess.run(["pdftoppm", "-r", str(DPI), "-png", str(pdf), f"{td}/p"], check=True)
        names = []
        for i, png in enumerate(sorted(Path(td).glob("p-*.png"), key=lambda x: int(x.stem.split("-")[-1])), 1):
            name = f"{prefix}-{i:03d}.webp"
            with Image.open(png) as im:
                im.convert("RGB").save(outdir / name, "WEBP", quality=72, method=6)
            names.append(name)
    return names


def is_skip_page(t: str) -> bool:
    s = re.sub(r"\s", "", t)
    return len(s) < 40 or "白紙" in s and len(s) < 200 or "持ち帰ることができます" in s


def split_question_pages(texts: list[str]) -> dict[int, dict]:
    """問題冊子のページを問ごとに振り分ける。"""
    starts = {}
    for i, t in enumerate(texts):
        m = Q_START.search(t)
        if m and int(m.group(1)) not in starts:
            starts[int(m.group(1))] = (i, m.group(2).strip(" 　,、"))
    if not starts:  # 見出し文の形が違う場合のフォールバック
        for i, t in enumerate(texts[1:], 1):
            head = "\n".join([ln for ln in t.splitlines() if ln.strip()][:6])
            m = Q_START_LOOSE.search(head)
            if m and int(m.group(1)) not in starts:
                starts[int(m.group(1))] = (i, "")
    order = sorted(starts.items(), key=lambda kv: kv[1][0])
    result = {}
    for idx, (no, (pi, theme)) in enumerate(order):
        end = order[idx + 1][1][0] if idx + 1 < len(order) else len(texts)
        pages = [p for p in range(pi, end) if not is_skip_page(texts[p])]
        result[no] = {"theme": theme, "pages": pages, "text": "\n".join(texts[p] for p in pages)}
    return result


def split_by_marks(texts: list[str]) -> tuple[dict[int, str], dict[int, list[int]]]:
    """解答例・採点講評を「問N」の初出位置で分割。テキストとページ範囲を返す。"""
    full, offsets, pos = "", [], 0
    for t in texts:
        offsets.append(pos)
        full += t + "\n"
        pos = len(full)
    # 「問N」で始まる行ごとに区切り、同じNの断片は連結する
    # （問ごとに趣旨→解答例の順でも、趣旨まとめ→解答例まとめの順でも対応できる）
    marks = [(m.start(), int(m.group(1))) for m in ANS_MARK.finditer(full)]
    texts_by, pages_by = {}, {}

    def page_of(off):
        p = 0
        for i, o in enumerate(offsets):
            if o <= off:
                p = i
        return p

    for i, (a, n) in enumerate(marks):
        b = marks[i + 1][0] if i + 1 < len(marks) else len(full)
        seg = tidy(full[a:b])
        if re.sub(r"\s", "", seg) == f"問{n}":
            seg = ""
        texts_by[n] = (texts_by.get(n, "") + "\n\n" + seg).strip() if seg else texts_by.get(n, "")
        pages = range(page_of(a), page_of(max(a, b - 1)) + 1)
        pages_by.setdefault(n, [])
        pages_by[n] += [p for p in pages if p not in pages_by[n]]
    return texts_by, pages_by


def tidy(s: str) -> str:
    s = re.sub(r"[ \t]+\n", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def parse_slots(qtext: str) -> list[dict]:
    """設問部分から解答欄を推定する（推定なので完全ではない）。"""
    lines = [ln.strip() for ln in qtext.splitlines()]
    start = next((i for i, ln in enumerate(lines) if re.match(r"^設問\s*1(?![0-9])", ln)), None)
    if start is None:
        return []
    items, cur = [], None
    for ln in lines[start:]:
        if not ln:
            continue
        m = re.match(r"^設問\s*(\d+)\s*(.*)$", ln)
        if m:
            cur = {"q": m.group(1), "sub": None, "text": m.group(2)}
            items.append(cur)
            continue
        m = re.match(r"^\((\d+)\)\s*(.*)$", ln)
        if m and cur:
            cur = {"q": cur["q"], "sub": m.group(1), "text": m.group(2)}
            items.append(cur)
            continue
        if cur and len(cur["text"]) < 400:
            cur["text"] += ln
    # 小問があるのに親だけの項目は除く
    with_sub = {it["q"] for it in items if it["sub"]}
    items = [it for it in items if it["sub"] or it["q"] not in with_sub]
    slots = []
    for it in items:
        label = f"設問{it['q']}" + (f"({it['sub']})" if it["sub"] else "")
        text = re.sub(r"\s+", " ", it["text"]).strip()
        limit = re.search(r"(\d+)\s*字以内", text)
        blanks = re.search(r"([a-z])\s*[～~]\s*([a-z])\s*に入れる", text)
        single = re.search(r"本文中の\s*([a-z])\s*に入れる", text)
        if blanks and ord(blanks.group(2)) - ord(blanks.group(1)) < 10:
            for c in range(ord(blanks.group(1)), ord(blanks.group(2)) + 1):
                slots.append({"label": f"{label} {chr(c)}", "prompt": text[:220], "limit": int(limit.group(1)) if limit else None})
        else:
            if single:
                label += f" {single.group(1)}"
            slots.append({"label": label, "prompt": text[:220], "limit": int(limit.group(1)) if limit else None})
    return slots[:40]


def build_exam(ex: dict, local_dir: Path | None) -> dict | None:
    print(f"[{ex['id']}] {ex['label']}")
    out = DATA / "past" / ex["id"]
    try:
        qs = fetch(ex["qs"], local_dir)
        ans = fetch(ex["ans"], local_dir)
    except Exception as e:  # noqa: BLE001
        print(f"  skip: {e}", file=sys.stderr)
        return None
    cm = None
    if ex.get("cmnt"):
        try:
            cm = fetch(ex["cmnt"], local_dir)
        except Exception as e:  # noqa: BLE001
            print(f"  講評なし: {e}", file=sys.stderr)

    if out.exists():
        shutil.rmtree(out)
    q_imgs = render(qs, out, "q")
    a_imgs = render(ans, out, "a")
    qsplit = split_question_pages(page_texts(qs))
    atext, apages = split_by_marks(page_texts(ans))
    ctext = split_by_marks(page_texts(cm))[0] if cm else {}
    if not qsplit:
        print("  問の区切りを検出できず。全ページを問1として登録", file=sys.stderr)
        qsplit = {1: {"theme": "", "pages": list(range(len(q_imgs))), "text": ""}}

    base = f"data/past/{ex['id']}/"
    questions = []
    for no in sorted(qsplit):
        q = qsplit[no]
        questions.append({
            "no": no,
            "theme": q["theme"],
            "cite": f"出典：{ex['source']} 問{no}",
            "pages": [base + q_imgs[p] for p in q["pages"] if p < len(q_imgs)],
            "ansPages": [base + a_imgs[p] for p in apages.get(no, range(len(a_imgs))) if p < len(a_imgs)],
            "answerText": atext.get(no, ""),
            "commentText": ctext.get(no, ""),
            "slots": parse_slots(q["text"]),
        })
        print(f"  問{no}: {q['theme'] or '(テーマ不明)'} / {len(q['pages'])}p / 解答欄{len(questions[-1]['slots'])}")
    return {"id": ex["id"], "label": ex["label"], "source": ex["source"],
            "links": {k: ex.get(k) for k in ("qs", "ans", "cmnt")}, "questions": questions}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--local", type=Path, help="PDFを置いたディレクトリ（ダウンロードしない）")
    ap.add_argument("--only", help="指定IDだけ処理（カンマ区切り）")
    args = ap.parse_args()
    src = json.loads((ROOT / "scripts" / "sources.json").read_text(encoding="utf-8"))
    exams = src["exams"]
    if args.only:
        ids = set(args.only.split(","))
        exams = [e for e in exams if e["id"] in ids]
    built = [b for e in exams if (b := build_exam(e, args.local))]
    DATA.mkdir(exist_ok=True)
    (DATA / "catalog.json").write_text(json.dumps(
        {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "exams": built},
        ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"done: {len(built)}/{len(exams)} exams")
    if exams and not built:
        sys.exit(1)


if __name__ == "__main__":
    main()
