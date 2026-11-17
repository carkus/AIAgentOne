"""Builds the "AI Methods Across Projects" PDF: the AI methods used across the
projects in c:\\_work (per project: method, how it's used, what it does, plus a
methods x projects grid).

The content lives in content.json beside this script. Edit it by hand, or let
Settings' "Regenerate from projects" button (backend/src/ai_methods.py, local
dev only) update it from each project's own docs.

    python tools/ai-methods/make_pdf.py            # docs/ + frontend/public/docs/
    python tools/ai-methods/make_pdf.py out.pdf    # one other path

The docs/ copy is the one kept with the project; the frontend/public/docs/
copy ships with the next frontend deploy, where Settings' download link
serves it on the live site.
"""
import json
import shutil
import sys
from datetime import date
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.fonts import addMapping
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (KeepTogether, PageBreak, Paragraph, SimpleDocTemplate,
                                Spacer, Table, TableStyle)

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
CONTENT = HERE / "content.json"
PDF_NAME = "AI_Methods_Across_Projects.pdf"
OUTPUTS = [REPO / "docs" / PDF_NAME, REPO / "frontend" / "public" / "docs" / PDF_NAME]

F = Path(r"C:\Windows\Fonts")
pdfmetrics.registerFont(TTFont("Segoe", str(F / "segoeui.ttf")))
pdfmetrics.registerFont(TTFont("Segoe-B", str(F / "segoeuib.ttf")))
pdfmetrics.registerFont(TTFont("Segoe-I", str(F / "segoeuii.ttf")))
pdfmetrics.registerFont(TTFont("Segoe-BI", str(F / "segoeuiz.ttf")))
addMapping("Segoe", 0, 0, "Segoe"); addMapping("Segoe", 1, 0, "Segoe-B")
addMapping("Segoe", 0, 1, "Segoe-I"); addMapping("Segoe", 1, 1, "Segoe-BI")

NAVY = colors.HexColor("#16324a")
TEAL = colors.HexColor("#1f6f73")
TEXT = colors.HexColor("#33475a")
META = colors.HexColor("#6b7785")
RULE = colors.HexColor("#ddd9cd")
HEAD_BG = colors.HexColor("#eaf3f7")
ZEBRA = colors.HexColor("#f7f5f0")

title = ParagraphStyle("t", fontName="Segoe-B", fontSize=22, leading=27, textColor=NAVY)
sub = ParagraphStyle("s", fontName="Segoe", fontSize=10.5, leading=14, textColor=META)
h1 = ParagraphStyle("h1", fontName="Segoe-B", fontSize=15, leading=19, textColor=NAVY,
                    spaceBefore=4, spaceAfter=2)
tag = ParagraphStyle("tag", fontName="Segoe", fontSize=8.5, leading=11, textColor=TEAL, spaceAfter=3)
body = ParagraphStyle("b", fontName="Segoe", fontSize=9.5, leading=13, textColor=TEXT, spaceAfter=6)
cell = ParagraphStyle("c", fontName="Segoe", fontSize=8.3, leading=10.8, textColor=TEXT)
cellb = ParagraphStyle("cb", parent=cell, fontName="Segoe-B", textColor=NAVY)
hcell = ParagraphStyle("hc", parent=cell, fontName="Segoe-B", textColor=NAVY)
hcell_c = ParagraphStyle("hcc", parent=hcell, alignment=1, fontSize=7.3, leading=9)
mark = ParagraphStyle("m", parent=cell, alignment=1, textColor=TEAL, fontName="Segoe-B")

W = A4[0] - 3.2 * cm
# Projects that start on a fresh page (long sections).
PAGE_BREAK_BEFORE = {"AgentOne", "ChattyPrayers.Api", "baby-meta-agent"}


def P(text, style):
    """Paragraph from plain text. reportlab reads its own mini-markup, so text
    (much of it model-written) is escaped: an `<svg>` would otherwise vanish."""
    return Paragraph(escape(str(text or "")), style)


def table(rows, widths, header):
    data = [[P(h, hcell) for h in header]]
    for r in rows:
        data.append([P(r[0], cellb)] + [P(x, cell) for x in r[1:]])
    t = Table(data, colWidths=widths, repeatRows=1)
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), HEAD_BG),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ]
    for i in range(2, len(data), 2):
        style.append(("BACKGROUND", (0, i), (-1, i), ZEBRA))
    t.setStyle(TableStyle(style))
    return t


def footer(c, d):
    c.saveState()
    c.setFont("Segoe", 7.5); c.setFillColor(META)
    c.drawString(1.6 * cm, 1.0 * cm, "AI methods across projects")
    c.drawRightString(A4[0] - 1.6 * cm, 1.0 * cm, f"Page {d.page}")
    c.restoreState()


def load_content() -> dict:
    return json.loads(CONTENT.read_text(encoding="utf-8"))


def _month_year(iso: str) -> str:
    try:
        return date.fromisoformat(iso).strftime("%B %Y")
    except (TypeError, ValueError):
        return date.today().strftime("%B %Y")


def build(out: Path, content: dict) -> None:
    projects = content["projects"]
    matrix = content["matrix"]
    out.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(str(out), pagesize=A4, leftMargin=1.6 * cm, rightMargin=1.6 * cm,
                            topMargin=1.5 * cm, bottomMargin=1.6 * cm,
                            title=content.get("title", ""), author=content.get("author", ""))
    byline = " · ".join(x for x in (content.get("author"), _month_year(content.get("updated")),
                                    content.get("subtitle")) if x)
    s = [P(content.get("title", ""), title), Spacer(1, 3), P(byline, sub), Spacer(1, 12)]

    s.append(P("Projects at a glance", h1))
    s.append(table([(p["name"], p.get("tag", ""), p.get("what") or "Smaller AI projects and reference work.")
                    for p in projects],
                   [3.6 * cm, 4.6 * cm, W - 8.2 * cm], ["Project", "Stack / status", "What it is"]))
    s.append(PageBreak())

    cols = matrix["columns"]
    s.append(P("Methods × projects", h1))
    cw = (W - 5.6 * cm) / len(cols)
    data = [[P("Method", hcell)] + [P(c["label"], hcell_c) for c in cols]]
    for row in matrix["rows"]:
        data.append([P(row["method"], cell)] + [P("●" if f else "", mark) for f in row["flags"]])
    t = Table(data, colWidths=[5.6 * cm] + [cw] * len(cols), repeatRows=1)
    st = [("BACKGROUND", (0, 0), (-1, 0), HEAD_BG), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
          ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE),
          ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
          ("LEFTPADDING", (1, 0), (-1, -1), 2), ("RIGHTPADDING", (1, 0), (-1, -1), 2)]
    for i in range(2, len(data), 2):
        st.append(("BACKGROUND", (0, i), (-1, i), ZEBRA))
    t.setStyle(TableStyle(st))
    s.append(t)

    for p in projects:
        s.append(PageBreak() if p["name"] in PAGE_BREAK_BEFORE else Spacer(1, 14))
        head = [P(p["name"], h1), P(p.get("tag", ""), tag)]
        if p.get("what"):
            head.append(P(p["what"], body))
        rows = [(r["method"], r["how"], r["does"]) for r in p["rows"]]
        tbl = table(rows, [4.2 * cm, (W - 4.2 * cm) * 0.55, (W - 4.2 * cm) * 0.45],
                    ["AI method", "How it's used", "What it does"])
        if len(rows) <= 6:
            s.append(KeepTogether(head + [tbl]))
        else:
            s.append(KeepTogether(head))
            s.append(tbl)

    doc.build(s, onFirstPage=footer, onLaterPages=footer)


def build_all(content: dict | None = None) -> list[Path]:
    """Builds the PDF once and copies it to every OUTPUTS path."""
    content = content or load_content()
    build(OUTPUTS[0], content)
    for extra in OUTPUTS[1:]:
        extra.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(OUTPUTS[0], extra)
    return OUTPUTS


if __name__ == "__main__":
    if len(sys.argv) > 1:
        build(Path(sys.argv[1]), load_content())
        print(f"Wrote {sys.argv[1]}")
    else:
        for path in build_all():
            print(f"Wrote {path}")
