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

OCR_CACHE = ROOT / ".cache" / "ocr"
# 空白を除いた本文に対して照合する（OCRは文字間に空白を入れるため）。「問」は「間」と誤読されることがある
Q_START = re.compile(r"[問間]([1-4])(.{0,60}?)に関する次の記述を読んで")
Q_START_LOOSE = re.compile(r"^[|\[\]\s]*[問間]([1-4])(?![0-9])")
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


def compact(s: str) -> str:
    return re.sub(r"\s", "", s)


def ocr(png: Path, key: str) -> str:
    OCR_CACHE.mkdir(parents=True, exist_ok=True)
    c = OCR_CACHE / f"{key}.txt"
    if c.exists():
        return c.read_text(encoding="utf-8")
    t = subprocess.run(["tesseract", str(png), "-", "-l", "jpn", "--psm", "6"],
                       capture_output=True).stdout.decode("utf-8", "replace")
    t = nfkc(t)
    c.write_text(t, encoding="utf-8")
    return t


def render(pdf: Path, outdir: Path, prefix: str, ocr_pages: set[int] = frozenset()) -> tuple[list[str], dict[int, str]]:
    """ページをWebP化する。ocr_pagesのページ（0始まり）はOCRしたテキストも返す。"""
    outdir.mkdir(parents=True, exist_ok=True)
    names, texts = [], {}
    with tempfile.TemporaryDirectory() as td:
        subprocess.run(["pdftoppm", "-r", str(DPI), "-png", str(pdf), f"{td}/p"], check=True)
        for i, png in enumerate(sorted(Path(td).glob("p-*.png"), key=lambda x: int(x.stem.split("-")[-1]))):
            name = f"{prefix}-{i + 1:03d}.webp"
            with Image.open(png) as im:
                im.convert("RGB").save(outdir / name, "WEBP", quality=72, method=6)
            names.append(name)
            if i in ocr_pages:
                texts[i] = ocr(png, f"{pdf.stem}-{i + 1:03d}")
    return names, texts


def is_skip_page(t: str) -> bool:
    s = compact(t)
    return (len(s) < 40 or ("白紙" in s and len(s) < 200)
            or any(k in s for k in ("持ち帰ることができます", "退室可能時間", "試験終了後")))


def split_question_pages(texts: list[str]) -> dict[int, dict]:
    """問題冊子のページを問ごとに振り分ける。"""
    starts = {}
    for i, t in enumerate(texts):
        m = Q_START.search(compact(t))
        if m and int(m.group(1)) not in starts:
            starts[int(m.group(1))] = (i, m.group(2).strip(",、"))
    if not starts:  # 見出し文の形が違う場合のフォールバック
        for i, t in enumerate(texts[1:], 1):
            for ln in [ln for ln in t.splitlines() if ln.strip()][:4]:
                m = Q_START_LOOSE.search(ln)
                if m and int(m.group(1)) not in starts:
                    starts[int(m.group(1))] = (i, "")
                    break
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


SUB = re.compile(r"^[(（]\S{1,3}?[)）]|^[①-⑳⑪-⑿⓪-⓿]{1,2}")


def parse_slots(qtext: str, noisy: bool = False) -> list[dict]:
    """設問部分から解答欄を推定する（推定なので完全ではない）。
    noisy=True（OCR由来）のときは小問番号を出現順で振り直し、空欄記号の読み取りはしない。"""
    lines = [re.sub(r"^[|\[\]\s]+", "", compact(ln)) for ln in qtext.splitlines()]
    start = next((i for i, ln in enumerate(lines) if re.match(r"^設[問間]1(?![0-9])", ln)), None)
    if start is None:
        return []
    items, cur, qno = [], None, 0
    for ln in lines[start:]:
        if not ln:
            continue
        m = re.match(r"^設[問間](\d+)(.*)$", ln)
        if m and int(m.group(1)) == qno + 1:
            qno += 1
            cur = {"q": str(qno), "sub": None, "subn": 0, "text": m.group(2)}
            items.append(cur)
            continue
        m = SUB.match(ln)
        if not m and noisy and cur and cur["sub"] is None and cur["subn"] == 0 and "について答えよ" in cur["text"]:
            m = re.match(r"^[^ぁ-んァ-ヶ一-龠]{0,6}", ln)  # 「(1)」がOCRで崩れた行を小問(1)とみなす
        if m and cur:
            n = cur["subn"] + 1
            if not noisy:
                d = re.search(r"\d+", m.group(0))
                n = int(d.group(0)) if d else n
            cur = {"q": cur["q"], "sub": str(n), "subn": n, "text": ln[m.end():]}
            items.append(cur)
            continue
        if cur and len(cur["text"]) < 400:
            cur["text"] += ln
    with_sub = {it["q"] for it in items if it["sub"]}
    items = [it for it in items if it["sub"] or it["q"] not in with_sub]
    slots = []
    for it in items:
        label = f"設問{it['q']}" + (f"({it['sub']})" if it["sub"] else "")
        text = it["text"]
        limit = re.search(r"(\d+)字以内", text)
        lim = int(limit.group(1)) if limit else None
        if noisy:  # OCRの字数は誤読しやすいので、ありがちな値だけ採用
            slots.append({"label": label, "prompt": "", "limit": lim if lim and lim >= 10 and lim % 5 == 0 else None})
            continue
        blanks = re.search(r"([a-z])[～~]([a-z])に入れる", text)
        single = re.search(r"本文中の([a-z])に入れる", text)
        if blanks and ord(blanks.group(2)) - ord(blanks.group(1)) < 10:
            for c in range(ord(blanks.group(1)), ord(blanks.group(2)) + 1):
                slots.append({"label": f"{label} {chr(c)}", "prompt": text[:220], "limit": lim})
        else:
            if single:
                label += f" {single.group(1)}"
            slots.append({"label": label, "prompt": text[:220], "limit": lim})
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
    qtexts = page_texts(qs)
    empty = {i for i, t in enumerate(qtexts) if len(compact(t)) < 30}
    noisy = len(empty) > len(qtexts) // 2  # 文字情報のない（スキャン）PDF → OCR
    if noisy:
        print(f"  テキストなし→OCR {len(empty)}ページ")
    q_imgs, ocr_texts = render(qs, out, "q", empty if noisy else set())
    for i, t in ocr_texts.items():
        if i < len(qtexts):
            qtexts[i] = t
    a_imgs, _ = render(ans, out, "a")
    qsplit = split_question_pages(qtexts)
    atext, apages = split_by_marks(page_texts(ans))
    ctext = split_by_marks(page_texts(cm))[0] if cm else {}
    if not qsplit:
        print("  問の区切りを検出できず。全ページを問1として登録", file=sys.stderr)
        qsplit = {1: {"theme": "", "pages": list(range(len(q_imgs))), "text": ""}}

    base = f"data/past/{ex['id']}/"
    questions = []
    for no in sorted(qsplit):
        q = qsplit[no]
        theme = ex.get("themes", {}).get(str(no), q["theme"])
        questions.append({
            "no": no,
            "theme": theme,
            "cite": f"出典：{ex['source']} 問{no}",
            "pages": [base + q_imgs[p] for p in q["pages"] if p < len(q_imgs)],
            "ansPages": [base + a_imgs[p] for p in apages.get(no, range(len(a_imgs))) if p < len(a_imgs)],
            "answerText": atext.get(no, ""),
            "commentText": ctext.get(no, ""),
            "slots": parse_slots(q["text"], noisy),
        })
        print(f"  問{no}: {theme or '(テーマ不明)'} / {len(q['pages'])}p / 解答欄{len(questions[-1]['slots'])}")
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
