"""Convert the shop's Word location sheets + Vend export into seed data for the app."""
import json, re, sys
from datetime import datetime
import docx, openpyxl
from lxml import etree

STORE, ROOM, VEND, OUT = sys.argv[1:5]
CODE_RE = re.compile(r'(?<![A-Za-z0-9])([A-Za-z]{0,3})\s?(\d{3,7})([A-Za-z]?)(?![0-9])')

def clean(s):
    return re.sub(r'\s+', ' ', s.replace('’', "'")).strip(' /-,&')

def items_from_text(text):
    """Split free text into [{code, note}] items; text without code becomes a note-only item."""
    text = text.replace('//', ' / ')
    out, last_end, matches = [], 0, list(CODE_RE.finditer(text))
    lead = clean(text[:matches[0].start()]) if matches else clean(text)
    for i, m in enumerate(matches):
        letters, digits, suf = m.group(1).upper(), m.group(2), m.group(3).upper()
        if not letters and len(digits) < 4:
            continue
        # A single trailing letter only counts as a suffix (K kids / M men) if it isn't the start of a word
        nxt = text[m.end():m.end()+1]
        if suf and nxt.isalpha():
            suf = ''
            end = m.end() - 1
        else:
            end = m.end()
        stop = matches[i+1].start() if i + 1 < len(matches) else len(text)
        note = clean(text[end:stop])
        out.append({'code': letters + digits + suf, 'note': note})
    if lead:
        out.insert(0, {'code': '', 'note': lead})
    return out

locations = []

# ---------- Storeroom: one table = one shelving unit ----------
d = docx.Document(ROOM)
for ti, t in enumerate(d.tables):
    seen = {}
    for r, row in enumerate(t.rows):
        for c, cell in enumerate(row.cells):
            k = cell._tc
            if k in seen:
                s = seen[k]; s['r2'] = max(s['r2'], r); s['c2'] = max(s['c2'], c)
            else:
                seen[k] = {'r1': r, 'c1': c, 'r2': r, 'c2': c, 'text': cell.text.replace('\n', ' / ')}
    unit = f'R{ti+1}'
    for s in seen.values():
        locations.append({
            'id': f"{unit}-{s['r1']+1}-{s['c1']+1}", 'area': 'storeroom', 'unit': unit,
            'row': s['r1'], 'col': s['c1'], 'rowspan': s['r2']-s['r1']+1, 'colspan': s['c2']-s['c1']+1,
            'rows': len(t.rows), 'cols': len(t.columns),
            'raw': clean(s['text']), 'items': items_from_text(s['text']),
        })

# ---------- Store floor: each text box = one display ----------
ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
      'mc': 'http://schemas.openxmlformats.org/markup-compatibility/2006',
      'wp': 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
      'wps': 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape'}
import zipfile
xml = etree.fromstring(zipfile.ZipFile(STORE).read('word/document.xml'))
boxes = []
for ch in xml.iter('{%s}Choice' % ns['mc']):
    anc = ch.find('.//wp:anchor', ns)
    if anc is None:
        continue
    paras = []
    for p in ch.findall('.//wps:txbx//w:p', ns):
        buf = ''
        for x in p.iter('{%s}t' % ns['w'], '{%s}br' % ns['w'], '{%s}tab' % ns['w']):
            if not x.tag.endswith('}t'):
                buf += ' / '; continue
            piece = x.text or ''
            # a new run that starts with a style code right after a word -> separate it
            if buf and buf[-1].isalpha() and re.match(r'[A-Za-z]{1,3}\s?\d{3}', piece):
                buf += ' / '
            buf += piece
        paras.append(buf)
    text = ' / '.join(p for p in paras if p.strip())
    boxes.append(text)
n = 0
for text in boxes:
    if not clean(text):
        continue
    # Split "Down cabinet: ... Upper cabinet: ..." into two locations
    parts = re.split(r'(Down cabinet:|Upper cabinet:)', text)
    segs = []
    if len(parts) > 1:
        lead = clean(parts[0])
        if lead:
            segs.append(('', lead))
        for i in range(1, len(parts), 2):
            segs.append(('下柜' if parts[i].startswith('Down') else '上柜', parts[i+1]))
    else:
        segs.append(('', text))
    n += 1
    for sub, seg in segs:
        locations.append({
            'id': f"S{n:02d}" + ({'下柜': '-D', '上柜': '-U'}.get(sub, '')), 'area': 'store', 'unit': f'S{n:02d}',
            'sub': sub, 'raw': clean(seg), 'items': items_from_text(seg),
        })

# ---------- Vend ----------
wb = openpyxl.load_workbook(VEND, data_only=True)
ws = wb.active
hdr = [str(h or '').strip() for h in next(ws.iter_rows(min_row=1, max_row=1, values_only=True))]
ix = {h: i for i, h in enumerate(hdr) if h}
products = {}
for row in ws.iter_rows(min_row=2, values_only=True):
    name, tag = row[ix['Product']], row[ix['Tag']]
    if not name:
        continue
    code = re.sub(r'\s', '', str(tag or '')).upper()
    key = code or ('NAME:' + str(name))
    cur = row[ix['Current Inventory']]
    p = products.setdefault(key, {'code': code, 'name': str(name).strip(), 'qty': 0, 'closing': 0, 'lastReceived': ''})
    p['qty'] += int(cur or 0); p['closing'] += int(row[ix['Closing Inventory']] or 0)
    lr = str(row[ix['Last received date']] or '')
    p['lastReceived'] = max(p['lastReceived'], lr)

codes = {i['code'] for l in locations for i in l['items'] if i['code']}
def resolve(c):
    if c in products: return c
    if c[-1:] in 'KM' and c[:-1] in products: return c[:-1]
    return None
unmatched = sorted(c for c in codes if not resolve(c))
noloc = sorted(k for k in products if products[k]['code'] and products[k]['code'] not in {resolve(c) for c in codes})
seed = {'generated': datetime.now().isoformat(timespec='seconds'), 'locations': locations,
        'products': list(products.values())}
with open(OUT, 'w', encoding='utf8') as f:
    f.write('// Auto-generated by tools/convert.py — initial data from the Word location sheets and Vend export.\n')
    f.write('window.SEED_DATA = ' + json.dumps(seed, ensure_ascii=False, indent=1) + ';\n')
print('locations', len(locations), 'store', sum(l['area']=='store' for l in locations), 'room', sum(l['area']=='storeroom' for l in locations))
print('products', len(products), 'with code', sum(1 for p in products.values() if p['code']))
print('codes on shelves', len(codes), 'unmatched', len(unmatched), unmatched)
print('vend products w/o location', len(noloc), [ (k, products[k]['name'], products[k]['qty']) for k in noloc if products[k]['qty']>0][:80])
