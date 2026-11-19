"""Turn a Vend "inventory by product variant" xlsx into data/variants.js
usage: python3 tools/variants_to_js.py report.xlsx data/variants.js [importedAt]"""
import sys, json, re, datetime, openpyxl
src, out = sys.argv[1], sys.argv[2]
at = sys.argv[3] if len(sys.argv) > 3 else datetime.datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
rows = list(openpyxl.load_workbook(src, data_only=True).active.iter_rows(values_only=True))
h = [str(x or '').strip().lower() for x in rows[0]]
ni, ti, ci = h.index('sku name'), h.index('tag'), h.index('current inventory')
lst, names = {}, {}
for r in rows[1:]:
    code = re.sub(r'\s+', '', str(r[ti] or '')).upper()
    if not code: continue
    parts = [p.strip() for p in str(r[ni]).split(' / ')]
    size = parts[-1] if len(parts) >= 2 else ''
    color = '/'.join(parts[1:-1]) if len(parts) >= 3 else ''
    names.setdefault(code, parts[0])
    q = int(r[ci] or 0)
    if q > 0: lst.setdefault(code, []).append([color, size, q])
data = {'importedAt': at, 'file': src.split('/')[-1], 'names': names, 'list': lst}
open(out, 'w').write('window.VARIANT_SEED = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n')
print(len(lst), 'styles', sum(len(v) for v in lst.values()), 'rows')
