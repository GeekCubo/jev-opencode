"""Renders a tmux `capture-pane -e` ANSI capture to PNG (truecolor SGR only). Usage: ansi2png.py in.ansi out.png"""
import re
import sys

from PIL import Image, ImageDraw, ImageFont

FONT = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 14)
CW, CH = 9, 18
DEF_FG, DEF_BG = (220, 220, 220), (10, 10, 10)
SGR = re.compile(r"\x1b\[([0-9;]*)m")


def parse(line):
    fg, bg, cells, pos = DEF_FG, DEF_BG, [], 0
    for m in SGR.finditer(line):
        cells += [(ch, fg, bg) for ch in line[pos:m.start()]]
        pos = m.end()
        p = [int(x) for x in m.group(1).split(";") if x] or [0]
        i = 0
        while i < len(p):
            if p[i] == 0:
                fg, bg = DEF_FG, DEF_BG
            elif p[i] in (38, 48) and i + 4 < len(p) and p[i + 1] == 2:
                c = tuple(p[i + 2:i + 5])
                fg, bg = (c, bg) if p[i] == 38 else (fg, c)
                i += 4
            elif p[i] == 39:
                fg = DEF_FG
            elif p[i] == 49:
                bg = DEF_BG
            i += 1
    cells += [(ch, fg, bg) for ch in line[pos:]]
    return cells


lines = [parse(l) for l in open(sys.argv[1], encoding="utf-8").read().split("\n")]
w = max(len(l) for l in lines)
img = Image.new("RGB", (w * CW + 16, len(lines) * CH + 16), DEF_BG)
d = ImageDraw.Draw(img)
for y, cells in enumerate(lines):
    for x, (ch, fg, bg) in enumerate(cells):
        X, Y = 8 + x * CW, 8 + y * CH
        if bg != DEF_BG:
            d.rectangle([X, Y, X + CW, Y + CH], fill=bg)
        if ch.strip():
            d.text((X, Y), ch, font=FONT, fill=fg)
img.save(sys.argv[2])
