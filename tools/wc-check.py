# sanity check the prepped tiles by reading them the way the app will (gzip -> bytes -> index)
# usage: python3 tools/wc-check.py [lat lon ...]
import sys, os, json, gzip, math
here = os.path.dirname(__file__)
wc = os.path.join(here, "..", "wc")
idx = json.load(open(os.path.join(wc, "index.json")))
T, P, N = idx["tileDeg"], idx["pxDeg"], idx["tilePx"]
names = idx["codes"]

def bucket(lat, lon):
    li, lo = math.floor(lat / T), math.floor(lon / T)
    path = os.path.join(wc, f"{li}_{lo}.bin.gz")
    if not os.path.exists(path): return "no tile"
    b = gzip.open(path).read()
    r = math.floor(((li + 1) * T - lat) / P); c = math.floor((lon - lo * T) / P)
    return names[str(b[r * N + c])]

# known spots; expected in comments (single pixel, so edges may legitimately differ)
SPOTS = [
    (45.4215, -75.7100, "Ottawa River off Rockcliffe -> water"),
    (45.3940, -75.7550, "Centre Jules-Leger field -> open"),
    (45.5100, -75.8600, "Gatineau Park -> forest"),
    (45.4236, -75.6950, "downtown, Rideau/Sussex -> built"),
    (45.3700, -75.6500, "Mer Bleue bog -> water/open (wetland)"),
]
args = [float(a) for a in sys.argv[1:]]
if args: SPOTS = [(args[i], args[i + 1], "") for i in range(0, len(args), 2)]
for lat, lon, note in SPOTS:
    print(f"{lat:.4f}, {lon:.4f}  {bucket(lat, lon):8s} {note}")
