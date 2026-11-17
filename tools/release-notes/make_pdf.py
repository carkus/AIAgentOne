"""Build the Agent One release notes PDF.

The text comes from frontend/src/releaseNotes.json, the same file the
in-app Release Notes page (#/release-notes) renders, so the PDF and the page
always match. The JSON lists releases newest first; the PDF is one release.
Edit the JSON, then run:

    python tools/release-notes/make_pdf.py                    # newest release, next to this script
    python tools/release-notes/make_pdf.py --version 0.9.0    # an older release
    python tools/release-notes/make_pdf.py -o out.pdf         # to a path of your choice

Warns when the newest release's version doesn't match frontend/package.json
(see CLAUDE.md, Versioning).

Needs reportlab (pip install reportlab). Uses Segoe UI and Consolas from
C:\\Windows\\Fonts.
"""
import argparse
import json
import re
import sys
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.fonts import addMapping
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (Image, KeepTogether, PageBreak, Paragraph,
                                SimpleDocTemplate, Spacer, Table, TableStyle)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
RELEASES = json.loads((ROOT / "frontend/src/releaseNotes.json").read_text(encoding="utf-8"))["releases"]
APP_VERSION = json.loads((ROOT / "frontend/package.json").read_text(encoding="utf-8"))["version"]
LOGO = ROOT / "frontend/src/assets/agentone_logo_transparent.png"

ap = argparse.ArgumentParser(description="Build the Agent One release notes PDF.")
ap.add_argument("--version", help="release to build (default: the newest)")
ap.add_argument("-o", "--out", help="output path (default: next to this script)")
args = ap.parse_args()

if RELEASES[0]["version"] != APP_VERSION:
    print(f"warning: newest release is v{RELEASES[0]['version']} but package.json says {APP_VERSION}",
          file=sys.stderr)
if args.version:
    match = [r for r in RELEASES if r["version"] == args.version]
    if not match:
        sys.exit(f"no release v{args.version}; have: " + ", ".join(r["version"] for r in RELEASES))
    NOTES = match[0]
else:
    NOTES = RELEASES[0]
VERSION = NOTES["version"]
OUT = Path(args.out) if args.out else HERE / f"AgentOne_release_notes_v{VERSION}.pdf"

F = Path(r"C:\Windows\Fonts")
pdfmetrics.registerFont(TTFont("Segoe", str(F / "segoeui.ttf")))
pdfmetrics.registerFont(TTFont("Segoe-B", str(F / "segoeuib.ttf")))
pdfmetrics.registerFont(TTFont("Segoe-I", str(F / "segoeuii.ttf")))
pdfmetrics.registerFont(TTFont("Segoe-BI", str(F / "segoeuiz.ttf")))
pdfmetrics.registerFont(TTFont("Mono", str(F / "consola.ttf")))
addMapping("Segoe", 0, 0, "Segoe")
addMapping("Segoe", 1, 0, "Segoe-B")
addMapping("Segoe", 0, 1, "Segoe-I")
addMapping("Segoe", 1, 1, "Segoe-BI")

NAVY = colors.HexColor("#16324a")
TEAL = colors.HexColor("#1f6f73")
STEEL = colors.HexColor("#3f7ea0")
BODY = colors.HexColor("#33475a")
META = colors.HexColor("#6b7785")
RULE = colors.HexColor("#ddd9cd")
CREAM = colors.HexColor("#f2efe9")

h1 = ParagraphStyle("h1", fontName="Segoe-B", fontSize=22, leading=27, textColor=NAVY, spaceAfter=4)
kicker = ParagraphStyle("kicker", fontName="Segoe-B", fontSize=10, leading=13, textColor=STEEL, spaceAfter=4)
sub = ParagraphStyle("sub", fontName="Segoe", fontSize=10.5, leading=14, textColor=META, spaceAfter=10)
h2 = ParagraphStyle("h2", fontName="Segoe-B", fontSize=15, leading=19, textColor=NAVY, spaceBefore=14, spaceAfter=6)
h3 = ParagraphStyle("h3", fontName="Segoe-B", fontSize=11.5, leading=15, textColor=TEAL, spaceBefore=10, spaceAfter=3)
group = ParagraphStyle("group", parent=h3, fontSize=12.5, textColor=NAVY, spaceBefore=8)
p = ParagraphStyle("p", fontName="Segoe", fontSize=9.6, leading=13.4, textColor=BODY, spaceAfter=5)
lead = ParagraphStyle("lead", parent=p, fontSize=10.4, leading=14.6)
cell = ParagraphStyle("cell", fontName="Segoe", fontSize=8.7, leading=11.6, textColor=BODY)
cellb = ParagraphStyle("cellb", parent=cell, fontName="Segoe-B", textColor=NAVY)
head = ParagraphStyle("head", parent=cell, fontName="Segoe-B", textColor=colors.white)
label = ParagraphStyle("label", parent=cell, fontName="Segoe-B", textColor=STEEL)
small = ParagraphStyle("small", parent=p, fontSize=8.2, leading=11, textColor=META)


def md(text):
    """The JSON's inline marks (**bold**, `code`) as reportlab markup."""
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    return re.sub(r"`(.+?)`", r'<font name="Mono" size="8.4">\1</font>', text)


def table(columns, rows, widths):
    data = [[Paragraph(md(c), head) for c in columns]]
    data += [[Paragraph(md(c), cellb if j == 0 else cell) for j, c in enumerate(r)] for r in rows]
    t = Table(data, colWidths=widths, repeatRows=1)
    st = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4.5),
        ("LINEBELOW", (0, 0), (-1, -1), 0.5, RULE),
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
    ]
    st += [("BACKGROUND", (0, i), (-1, i), CREAM) for i in range(2, len(data), 2)]
    t.setStyle(TableStyle(st))
    return t


def fix(f):
    """A change: title + text (from release.py) or problem / fix / result."""
    parts = [Paragraph(md(f["title"]), h3)]
    if f.get("text"):
        parts.append(Paragraph(md(f["text"]), p))
    rows = [(k.capitalize(), f[k]) for k in ("problem", "fix", "result") if f.get(k)]
    if not rows:
        return KeepTogether(parts)
    t = Table([[Paragraph(a, label), Paragraph(md(b), cell)] for a, b in rows],
              colWidths=[17 * mm, 153 * mm])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 1.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
        ("LINEBEFORE", (0, 0), (0, -1), 2, TEAL),
    ]))
    return KeepTogether(parts + [t])


def footer(c, doc):
    c.saveState()
    c.setFont("Segoe", 7.5)
    c.setFillColor(META)
    c.drawString(20 * mm, 12 * mm, f"Agent One release notes · v{VERSION} · {NOTES['date']}")
    c.drawRightString(190 * mm, 12 * mm, str(doc.page))
    c.setStrokeColor(RULE)
    c.line(20 * mm, 16 * mm, 190 * mm, 16 * mm)
    c.restoreState()


s = []
logo = Image(str(LOGO))
logo.drawHeight = 52 * mm * logo.imageHeight / logo.imageWidth
logo.drawWidth = 52 * mm
logo.hAlign = "LEFT"
s += [logo, Spacer(1, 6)]
s.append(Paragraph(f"Release Notes · v{VERSION} · {NOTES['date']}", kicker))
s.append(Paragraph(md(NOTES["title"]), h1))
if NOTES.get("subtitle"):
    s.append(Paragraph(md(NOTES["subtitle"]), sub))
if NOTES.get("intro"):
    s.append(Paragraph(md(NOTES["intro"]), lead))

hl = NOTES.get("headline")
if hl:
    s.append(Paragraph(md(hl["title"]), h2))
    s.append(Paragraph(md(hl["text"]), p))
    s.append(table(hl["columns"], hl["rows"], [52 * mm, 42 * mm, 42 * mm, 34 * mm]))

if NOTES.get("groups"):
    if NOTES.get("fixesTitle"):
        s.append(Paragraph(md(NOTES["fixesTitle"]), h2))
    if NOTES.get("fixesNote"):
        s.append(Paragraph(md(NOTES["fixesNote"]), small))
    for g in NOTES["groups"]:
        s.append(Paragraph(md(g["title"]), group))
        s += [fix(f) for f in g["fixes"]]

if NOTES.get("services"):
    s.append(PageBreak())
    if NOTES.get("servicesTitle"):
        s.append(Paragraph(md(NOTES["servicesTitle"]), h2))
    if NOTES.get("servicesIntro"):
        s.append(Paragraph(md(NOTES["servicesIntro"]), p))
    W = [34 * mm, 36 * mm, 50 * mm, 50 * mm]
    for sec in NOTES["services"]:
        s.append(KeepTogether([Paragraph(md(sec["title"]), h3), table(sec["columns"], sec["rows"], W)]))

if NOTES.get("closing"):
    if NOTES.get("closingTitle"):
        s.append(Paragraph(md(NOTES["closingTitle"]), h2))
    s.append(Paragraph(md(NOTES["closing"]), p))

doc = SimpleDocTemplate(str(OUT), pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm,
                        topMargin=18 * mm, bottomMargin=22 * mm,
                        title=f"Agent One release notes v{VERSION}", author="Agent One project")
doc.build(s, onFirstPage=footer, onLaterPages=footer)
print(OUT)
