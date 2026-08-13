#!/usr/bin/env python3
"""Generate redesigned Elysian Properties management brochures (EN + GR)."""
from __future__ import annotations

import os
from pathlib import Path

from reportlab.lib.colors import Color, HexColor, white, black
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets"

# Brand
NAVY = HexColor("#0F1E2E")
NAVY_DEEP = HexColor("#0A1520")
GOLD = HexColor("#C9A84C")
GOLD_SOFT = HexColor("#E8D5A3")
INK = HexColor("#1A2330")
MUTED = HexColor("#5C6570")
LINE = HexColor("#D8DCE2")
SOFT = HexColor("#F3F5F7")
CARD = HexColor("#FFFFFF")
POP = HexColor("#16283A")

FONT_DIR = "/usr/share/fonts/truetype/dejavu"
pdfmetrics.registerFont(TTFont("ElysSans", f"{FONT_DIR}/DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("ElysSansBold", f"{FONT_DIR}/DejaVuSans-Bold.ttf"))
pdfmetrics.registerFont(TTFont("ElysSerif", f"{FONT_DIR}/DejaVuSerif.ttf"))
pdfmetrics.registerFont(TTFont("ElysSerifBold", f"{FONT_DIR}/DejaVuSerif-Bold.ttf"))


def wrap(c: canvas.Canvas, text: str, font: str, size: float, max_w: float) -> list[str]:
    words = text.split()
    lines, cur = [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if c.stringWidth(trial, font, size) <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines or [""]


def draw_wrapped(c, text, x, y, font, size, max_w, leading, color=INK, align="left"):
    lines = wrap(c, text, font, size, max_w)
    c.setFillColor(color)
    c.setFont(font, size)
    for i, line in enumerate(lines):
        yy = y - i * leading
        if align == "center":
            c.drawCentredString(x + max_w / 2, yy, line)
        else:
            c.drawString(x, yy, line)
    return len(lines) * leading


CONTENT = {
    "EN": {
        "file": "elysian-management-brochure-en.pdf",
        "lang_tag": "EN",
        "brand": "Elysian",
        "brand_sub": "Properties",
        "eyebrow": "PROPERTY MANAGEMENT",
        "cities": "Athens  ·  Athenian Riviera  ·  Thessaloniki  ·  Patra",
        "address": "17 November 19, Cholargos, Athens",
        "phone": "+30 210 260 2749",
        "email": "info@elysianproperties.eu",
        "web": "elysianproperties.eu",
        "sec1_num": "01",
        "sec1_title": "Elevated hospitality. Professional management.",
        "sec1_body": (
            "Elysian Properties turns distinctive homes into high-performing hospitality investments. "
            "Based in Athens with a presence in Thessaloniki, we combine deep local-market knowledge "
            "with hotel-grade operating standards — from dynamic pricing and marketing to professional "
            "cleaning, maintenance and 24/7 guest care."
        ),
        "stats": [
            ("120+", "Properties under management"),
            ("4.9 ★", "Average guest rating"),
            ("92%", "Average yearly occupancy"),
            ("24/7", "Guest support"),
        ],
        "sec2_num": "02",
        "sec2_title": "Management packages",
        "sec2_body": (
            "Three transparent programmes, priced as a share of net rental income — "
            "so our fee rises only when your performance does."
        ),
        "popular": "MOST POPULAR",
        "packages": [
            {
                "name": "ESSENTIAL",
                "rate": "15%",
                "rate_note": "of net rental income",
                "blurb": "Full launch & day-to-day operations with smart pricing and booking management.",
                "items": [
                    "Listing creation & optimisation",
                    "Dynamic pricing",
                    "24/7 guest messaging",
                    "Cleaning & turnover coordination",
                    "Monthly owner performance reports",
                ],
                "popular": False,
            },
            {
                "name": "SIGNATURE",
                "rate": "17.5%",
                "rate_note": "of net rental income",
                "blurb": "Enhanced operations, maintenance oversight and direct-booking support.",
                "items": [
                    "Everything in Essential",
                    "Maintenance supervision & coordination",
                    "Call-centre link for direct bookings",
                    "AADE tax-compliance management",
                ],
                "popular": True,
            },
            {
                "name": "ELITE",
                "rate": "20%",
                "rate_note": "of net rental income",
                "blurb": "The premium solution — full coverage, legal support and maximum visibility.",
                "items": [
                    "Everything in Signature",
                    "Full legal support",
                    "Maximum visibility (Web, OTAs, Call Centre)",
                    "VIP owner priority line",
                ],
                "popular": False,
            },
        ],
        "sec3_num": "03",
        "sec3_title": "Operating standards & hospitality supplies",
        "sec3_body": (
            "A fully transparent pass-through model for operating costs and guest supplies — "
            "charged at supplier cost, with no markup."
        ),
        "col_a_title": "Guest amenities & supplies",
        "col_a": [
            ("Welcome amenities", "Specialty coffee capsules, tea and bottled water."),
            ("Hotel-grade toiletries", "Shampoo, shower gel, soap and quality personal-care items."),
            ("Consumables", "Paper goods, cleaning products and hygiene supplies for every stay."),
            ("At-cost pricing", "Billed at real supplier cost — zero markup."),
        ],
        "col_b_title": "Cleaning & maintenance (per turnover)",
        "col_b": [
            ("Professional cleaning", "Specialist teams following hotel protocols."),
            ("Premium linen care", "Wash, press and hygienic care of bed & bath linen."),
            ("Technical checks", "Regular checks of appliances, plumbing and climate control."),
            ("Scaled pricing", "Fees adjusted to sq.m, bedrooms and bathrooms."),
        ],
        "transparency": (
            "Elysian transparency model: cleaning and hospitality-supply costs are billed directly "
            "from supplier and contractor prices. We add no margin to your property’s operating expenses."
        ),
        "footer": "Elysian Properties — Athens · Thessaloniki · Patra",
    },
    "GR": {
        "file": "elysian-management-brochure-gr.pdf",
        "lang_tag": "ΕΛ",
        "brand": "Elysian",
        "brand_sub": "Properties",
        "eyebrow": "ΔΙΑΧΕΙΡΙΣΗ ΑΚΙΝΗΤΩΝ",
        "cities": "Αθήνα  ·  Αθηναϊκή Ριβιέρα  ·  Θεσσαλονίκη  ·  Πάτρα",
        "address": "17ης Νοεμβρίου 19, Χολαργός",
        "phone": "+30 210 260 2749",
        "email": "info@elysianproperties.eu",
        "web": "elysianproperties.eu",
        "sec1_num": "01",
        "sec1_title": "Αναβαθμισμένη φιλοξενία. Επαγγελματική διαχείριση.",
        "sec1_body": (
            "Η Elysian Properties μετατρέπει ξεχωριστές κατοικίες σε εξαιρετικά αποδοτικά επενδυτικά "
            "ακίνητα φιλοξενίας. Με έδρα την Αθήνα και παρουσία στη Θεσσαλονίκη, συνδυάζουμε τη βαθιά "
            "γνώση της τοπικής αγοράς με λειτουργικά πρότυπα επιπέδου ξενοδοχείου — από τη στρατηγική "
            "δυναμική τιμολόγηση και το marketing, έως την επαγγελματική καθαριότητα, τη συντήρηση "
            "και την 24/7 εξυπηρέτηση."
        ),
        "stats": [
            ("120+", "Ακίνητα υπό διαχείριση"),
            ("4.9 ★", "Μέση αξιολόγηση επισκεπτών"),
            ("92%", "Μέση πληρότητα έτους"),
            ("24/7", "Υποστήριξη επισκεπτών"),
        ],
        "sec2_num": "02",
        "sec2_title": "Πακέτα υπηρεσιών διαχείρισης",
        "sec2_body": (
            "Τρία διαφανή προγράμματα, ως ποσοστό επί των καθαρών εσόδων (net rental income) — "
            "η αμοιβή μας αυξάνεται μόνο όταν αυξάνεται η δική σας απόδοση."
        ),
        "popular": "ΔΗΜΟΦΙΛΕΣΤΕΡΟ",
        "packages": [
            {
                "name": "ESSENTIAL",
                "rate": "15%",
                "rate_note": "επί καθαρών εσόδων",
                "blurb": "Πλήρες πακέτο έναρξης & καθημερινής λειτουργίας με έξυπνη τιμολόγηση και διαχείριση κρατήσεων.",
                "items": [
                    "Δημιουργία & βελτιστοποίηση καταχώρησης",
                    "Δυναμική τιμολόγηση (Dynamic Pricing)",
                    "24/7 επικοινωνία με επισκέπτες",
                    "Συντονισμός καθαριότητας & turnovers",
                    "Μηνιαίες αναφορές απόδοσης ιδιοκτήτη",
                ],
                "popular": False,
            },
            {
                "name": "SIGNATURE",
                "rate": "17.5%",
                "rate_note": "επί καθαρών εσόδων",
                "blurb": "Ενισχυμένη επιχειρησιακή υποστήριξη, συντήρηση ακινήτου και απευθείας κρατήσεις.",
                "items": [
                    "Όλα όσα περιλαμβάνει το Essential",
                    "Επίβλεψη & συντονισμός συντήρησης",
                    "Σύνδεση με Call Center (Direct Bookings)",
                    "Διαχείριση φορολογικής συμμόρφωσης ΑΑΔΕ",
                ],
                "popular": True,
            },
            {
                "name": "ELITE",
                "rate": "20%",
                "rate_note": "επί καθαρών εσόδων",
                "blurb": "Η απόλυτη premium λύση — πλήρης κάλυψη, νομική υποστήριξη και μέγιστη προβολή.",
                "items": [
                    "Όλα όσα περιλαμβάνει το Signature",
                    "Πλήρης νομική υποστήριξη",
                    "Μέγιστη προβολή (Web, OTAs, Call Center)",
                    "VIP γραμμή προτεραιότητας ιδιοκτήτη",
                ],
                "popular": False,
            },
        ],
        "sec3_num": "03",
        "sec3_title": "Πρότυπα λειτουργίας & αναλώσιμα φιλοξενίας",
        "sec3_body": (
            "Απόλυτα διαφανές μοντέλο (pass-through) για επιχειρησιακά έξοδα και αναλώσιμα — "
            "χρέωση στο πραγματικό κόστος προμηθευτών, χωρίς κανένα markup."
        ),
        "col_a_title": "Αναλώσιμα & παροχές επισκεπτών",
        "col_a": [
            ("Welcome amenities", "Εκλεκτές κάψουλες καφέ, τσάι και εμφιαλωμένο νερό."),
            ("Hotel-grade toiletries", "Σαμπουάν, αφρόλουτρο, σαπούνι και είδη ατομικής περιποίησης υψηλής ποιότητας."),
            ("Προμήθεια αναλωσίμων", "Χαρτικά, είδη καθαρισμού και αναλώσιμα υγιεινής για κάθε διαμονή."),
            ("Διαφάνεια τιμολόγησης", "Χρέωση στο πραγματικό κόστος προμηθευτών — χωρίς markup."),
        ],
        "col_b_title": "Καθαριότητα & συντήρηση (ανά turnover)",
        "col_b": [
            ("Επαγγελματικός καθαρισμός", "Εξειδικευμένα συνεργεία με ξενοδοχειακά πρωτόκολλα."),
            ("Ιματισμός υψηλής ποιότητας", "Πλύσιμο, σιδέρωμα και υγειονομική φροντίδα λευκών ειδών."),
            ("Τεχνικός έλεγχος", "Τακτικός έλεγχος συσκευών, υδραυλικών & κλιματισμού."),
            ("Κλιμακωτό κόστος", "Προσαρμογή αμοιβής βάσει τ.μ., υπνοδωματίων και μπανίων."),
        ],
        "transparency": (
            "Μοντέλο διαφάνειας Elysian Properties: τα έξοδα καθαρισμού και τα αναλώσιμα φιλοξενίας "
            "τιμολογούνται απευθείας βάσει των πραγματικών τιμών προμηθευτών και συνεργείων. "
            "Δεν προσθέτουμε κανένα επιπλέον περιθώριο κέρδους (markup) στα λειτουργικά έξοδα του ακινήτου σας."
        ),
        "footer": "Elysian Properties — Αθήνα · Θεσσαλονίκη · Πάτρα",
    },
}


def section_label(c, num, title, x, y):
    c.setFillColor(GOLD)
    c.setFont("ElysSansBold", 8)
    c.drawString(x, y, num)
    c.setFillColor(INK)
    c.setFont("ElysSerifBold", 13)
    c.drawString(x + 18, y - 1, title)
    return y - 18


def bullet(c, text, x, y, max_w, size=7.2):
    c.setFillColor(GOLD)
    c.circle(x + 2.2, y + 2.2, 1.4, fill=1, stroke=0)
    h = draw_wrapped(c, text, x + 9, y, "ElysSans", size, max_w - 9, size + 2.2, MUTED)
    return h + 3


def build(lang: str):
    t = CONTENT[lang]
    path = OUT / t["file"]
    W, H = A4
    c = canvas.Canvas(str(path), pagesize=A4)
    m = 12 * mm

    # Soft page ground
    c.setFillColor(SOFT)
    c.rect(0, 0, W, H, fill=1, stroke=0)

    # ── Hero ──────────────────────────────────────────────────────────────
    hero_h = 48 * mm
    c.setFillColor(NAVY)
    c.rect(0, H - hero_h, W, hero_h, fill=1, stroke=0)
    # Gold accent line under hero
    c.setFillColor(GOLD)
    c.rect(0, H - hero_h - 2.2, W, 2.2, fill=1, stroke=0)

    # Left brand block — brand is the hero signal
    c.setFillColor(GOLD)
    c.setFont("ElysSansBold", 7.5)
    c.drawString(m, H - 11 * mm, t["eyebrow"])

    c.setFillColor(white)
    c.setFont("ElysSerifBold", 26)
    c.drawString(m, H - 22.5 * mm, f"{t['brand']} {t['brand_sub']}")

    c.setStrokeColor(GOLD)
    c.setLineWidth(1.1)
    c.line(m, H - 26 * mm, m + 28 * mm, H - 26 * mm)

    c.setFillColor(HexColor("#9AABBA"))
    c.setFont("ElysSans", 8)
    c.drawString(m, H - 33.5 * mm, t["cities"])

    c.setFillColor(GOLD)
    c.setFont("ElysSansBold", 7)
    c.drawString(m, H - 41 * mm, t["lang_tag"])

    # Right contact stack
    rx = W - m
    c.setFillColor(GOLD_SOFT)
    c.setFont("ElysSans", 7.5)
    for i, line in enumerate([t["address"], t["phone"], t["email"], t["web"]]):
        c.drawRightString(rx, H - (14 + i * 5) * mm, line)

    y = H - hero_h - 9 * mm

    # ── Section 01 ────────────────────────────────────────────────────────
    y = section_label(c, t["sec1_num"], t["sec1_title"], m, y)
    used = draw_wrapped(c, t["sec1_body"], m, y, "ElysSans", 8.2, W - 2 * m, 11.2, MUTED)
    y -= used + 6 * mm

    # Stats strip
    stats = t["stats"]
    gap = 3 * mm
    box_w = (W - 2 * m - 3 * gap) / 4
    box_h = 16 * mm
    for i, (val, label) in enumerate(stats):
        x = m + i * (box_w + gap)
        c.setFillColor(NAVY if i % 2 == 0 else POP)
        c.roundRect(x, y - box_h, box_w, box_h, 3, fill=1, stroke=0)
        c.setFillColor(GOLD)
        c.setFont("ElysSerifBold", 13)
        c.drawCentredString(x + box_w / 2, y - 7 * mm, val)
        c.setFillColor(HexColor("#B8C4CE"))
        c.setFont("ElysSans", 6.2)
        # wrap label centered
        lines = wrap(c, label, "ElysSans", 6.2, box_w - 6)
        for li, ln in enumerate(lines[:2]):
            c.drawCentredString(x + box_w / 2, y - 11.2 * mm - li * 7.5, ln)
    y -= box_h + 8 * mm

    # ── Section 02 packages ───────────────────────────────────────────────
    y = section_label(c, t["sec2_num"], t["sec2_title"], m, y)
    used = draw_wrapped(c, t["sec2_body"], m, y, "ElysSans", 7.8, W - 2 * m, 10.5, MUTED)
    y -= used + 5 * mm

    pkgs = t["packages"]
    p_gap = 3.5 * mm
    p_w = (W - 2 * m - 2 * p_gap) / 3
    pad = 4.5 * mm
    # Measure content height per package so Greek/English both fit cleanly
    def pkg_inner_h(p):
        h = 6 * mm + 8 * mm + 3 * mm + 5 * mm
        h += len(wrap(c, p["blurb"], "ElysSans", 6.8, p_w - 2 * pad)) * 9.2 + 3 * mm
        for item in p["items"]:
            h += len(wrap(c, item, "ElysSans", 6.8, p_w - 2 * pad - 7)) * 9 + 2.2
        return h + 5 * mm

    p_h = max(pkg_inner_h(p) for p in pkgs)
    top = y
    pill_lift = 3.2 * mm

    for i, p in enumerate(pkgs):
        x = m + i * (p_w + p_gap)
        card_top = top - (pill_lift if p["popular"] else 0)
        card_h = p_h + (pill_lift if p["popular"] else 0)
        if p["popular"]:
            c.setFillColor(NAVY)
            c.roundRect(x, top - p_h - pill_lift, p_w, card_h, 4, fill=1, stroke=0)
            pill_w = c.stringWidth(t["popular"], "ElysSansBold", 6) + 12
            c.setFillColor(GOLD)
            c.roundRect(x + (p_w - pill_w) / 2, top - 1.2 * mm, pill_w, 5.2 * mm, 2.4, fill=1, stroke=0)
            c.setFillColor(NAVY)
            c.setFont("ElysSansBold", 6)
            c.drawCentredString(x + p_w / 2, top + 0.4 * mm, t["popular"])
            name_c, rate_c, note_c, body_c, item_c = white, GOLD, GOLD_SOFT, HexColor("#C5CED6"), HexColor("#D7DEE5")
            rule_c = HexColor("#2A3D52")
        else:
            c.setFillColor(CARD)
            c.setStrokeColor(LINE)
            c.setLineWidth(0.8)
            c.roundRect(x, top - p_h, p_w, p_h, 4, fill=1, stroke=1)
            name_c, rate_c, note_c, body_c, item_c = INK, NAVY, MUTED, MUTED, MUTED
            rule_c = LINE

        cy = card_top - 6 * mm
        c.setFillColor(name_c)
        c.setFont("ElysSansBold", 9)
        c.drawString(x + pad, cy, p["name"])
        cy -= 8 * mm
        c.setFillColor(rate_c)
        c.setFont("ElysSerifBold", 20)
        c.drawString(x + pad, cy, p["rate"])
        c.setFillColor(note_c)
        c.setFont("ElysSans", 6.5)
        c.drawString(x + pad + c.stringWidth(p["rate"], "ElysSerifBold", 20) + 3, cy + 2, p["rate_note"])
        cy -= 3 * mm
        c.setStrokeColor(rule_c)
        c.setLineWidth(0.6)
        c.line(x + pad, cy, x + p_w - pad, cy)
        cy -= 5 * mm
        used = draw_wrapped(c, p["blurb"], x + pad, cy, "ElysSans", 6.8, p_w - 2 * pad, 9.2, body_c)
        cy -= used + 3 * mm
        for item in p["items"]:
            c.setFillColor(GOLD)
            c.circle(x + pad + 1.8, cy + 1.8, 1.3, fill=1, stroke=0)
            h = draw_wrapped(c, item, x + pad + 7, cy, "ElysSans", 6.8, p_w - 2 * pad - 7, 9, item_c)
            cy -= h + 2.2

    y = top - p_h - (pill_lift if any(p["popular"] for p in pkgs) else 0) - 6 * mm

    # ── Section 03 ────────────────────────────────────────────────────────
    y = section_label(c, t["sec3_num"], t["sec3_title"], m, y)
    used = draw_wrapped(c, t["sec3_body"], m, y, "ElysSans", 7.6, W - 2 * m, 10.2, MUTED)
    y -= used + 4 * mm

    col_w = (W - 2 * m - 4 * mm) / 2
    col_h = 42 * mm
    for col_i, (title, items) in enumerate([(t["col_a_title"], t["col_a"]), (t["col_b_title"], t["col_b"])]):
        x = m + col_i * (col_w + 4 * mm)
        c.setFillColor(CARD)
        c.setStrokeColor(LINE)
        c.setLineWidth(0.7)
        c.roundRect(x, y - col_h, col_w, col_h, 3.5, fill=1, stroke=1)
        # left gold bar
        c.setFillColor(GOLD)
        c.rect(x, y - col_h, 1.8, col_h, fill=1, stroke=0)
        cy = y - 5.5 * mm
        c.setFillColor(INK)
        c.setFont("ElysSansBold", 8)
        c.drawString(x + 5 * mm, cy, title)
        cy -= 5 * mm
        for head, body in items:
            c.setFillColor(NAVY)
            c.setFont("ElysSansBold", 6.8)
            c.drawString(x + 5 * mm, cy, head)
            cy -= 8.5
            h = draw_wrapped(c, body, x + 5 * mm, cy, "ElysSans", 6.4, col_w - 8 * mm, 8.4, MUTED)
            cy -= h + 2.8

    y -= col_h + 5 * mm

    # Transparency callout
    call_h = 14 * mm
    c.setFillColor(HexColor("#EEF1F4"))
    c.roundRect(m, y - call_h, W - 2 * m, call_h, 3, fill=1, stroke=0)
    c.setFillColor(GOLD)
    c.rect(m, y - call_h, 2.2, call_h, fill=1, stroke=0)
    draw_wrapped(
        c, t["transparency"], m + 5 * mm, y - 4.5 * mm,
        "ElysSans", 6.6, W - 2 * m - 8 * mm, 8.8, MUTED
    )

    # Footer
    c.setFillColor(NAVY)
    c.rect(0, 0, W, 9 * mm, fill=1, stroke=0)
    c.setFillColor(GOLD)
    c.rect(0, 9 * mm, W, 1.2, fill=1, stroke=0)
    c.setFillColor(GOLD_SOFT)
    c.setFont("ElysSans", 7)
    c.drawString(m, 3.5 * mm, t["footer"])
    c.drawRightString(W - m, 3.5 * mm, f"{t['email']}  ·  {t['phone']}  ·  {t['web']}")

    c.showPage()
    c.save()
    print(f"wrote {path} ({path.stat().st_size} bytes)")
    return path


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    paths = [build("EN"), build("GR")]
    # Keep a stable default name pointing at GR (primary market) for older seed key
    default = OUT / "elysian-management-brochure.pdf"
    default.write_bytes((OUT / "elysian-management-brochure-gr.pdf").read_bytes())
    print(f"wrote {default} (copy of GR)")
    return paths


if __name__ == "__main__":
    main()
