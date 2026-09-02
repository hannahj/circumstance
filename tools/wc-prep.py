# ESA WorldCover -> game land-cover tiles. One-time, local.
# usage: python3 tools/wc-prep.py path/to/ESA_WorldCover_10m_2021_v200_N45W078_Map.tif
# needs: pip install tifffile zarr numpy
import sys, os, json, gzip, math
import numpy as np, tifffile

# region kept (Ottawa + margin), snapped to the 0.05 deg tile grid
LAT0, LAT1 = 45.05, 45.65
LON0, LON1 = -76.35, -75.25
TILE_DEG = 0.05
PX_DEG = 1 / 12000          # WorldCover: 3 deg / 36000 px
TILE_PX = round(TILE_DEG / PX_DEG)   # 600

# WorldCover class -> game bucket: 0 open, 1 forest, 2 water, 3 built, 4 nodata
REMAP = np.full(256, 4, np.uint8)
for cls, b in {10: 1, 20: 0, 30: 0, 40: 0, 50: 3, 60: 0, 70: 0, 80: 2, 90: 2, 95: 2, 100: 0}.items():
    REMAP[cls] = b

src = sys.argv[1]
out = os.path.join(os.path.dirname(__file__), "..", "wc")
os.makedirs(out, exist_ok=True)

with tifffile.TiffFile(src) as tif:
    page = tif.pages[0]
    tie = page.tags["ModelTiepointTag"].value   # (i, j, k, x, y, z): pixel (0,0) is at (x, y)
    scale = page.tags["ModelPixelScaleTag"].value
    lon_left, lat_top = tie[3], tie[4]
    assert abs(scale[0] - PX_DEG) < 1e-9 and abs(scale[1] - PX_DEG) < 1e-9, scale
    H, W = page.shape[:2]
print(f"source origin {lat_top:.4f}N {lon_left:.4f}E, {W}x{H} px")

# source window covering the region; row 0 is the north edge
r0 = round((lat_top - LAT1) / PX_DEG); r1 = round((lat_top - LAT0) / PX_DEG)
c0 = round((LON0 - lon_left) / PX_DEG); c1 = round((LON1 - lon_left) / PX_DEG)
assert 0 <= r0 < r1 <= H and 0 <= c0 < c1 <= W, "region falls outside this source tile"
region = tifffile.imread(src, selection=(slice(r0, r1), slice(c0, c1)))
region = REMAP[region]
print("region px", region.shape, "bucket counts", np.bincount(region.ravel(), minlength=5).tolist())

# fixed 0.05 deg tiles keyed by floor(lat/0.05)_floor(lon/0.05), row-major, north row first
lat_i0, lat_i1 = round(LAT0 / TILE_DEG), round(LAT1 / TILE_DEG)
lon_i0, lon_i1 = round(LON0 / TILE_DEG), round(LON1 / TILE_DEG)
n, total = 0, 0
for li in range(lat_i0, lat_i1):
    rr = round((LAT1 - (li + 1) * TILE_DEG) / PX_DEG)   # north edge of this tile in region rows
    for lo in range(lon_i0, lon_i1):
        cc = round((lo * TILE_DEG - LON0) / PX_DEG)
        t = region[rr:rr + TILE_PX, cc:cc + TILE_PX]
        assert t.shape == (TILE_PX, TILE_PX), t.shape
        data = gzip.compress(t.tobytes(), 9)
        with open(os.path.join(out, f"{li}_{lo}.bin.gz"), "wb") as f: f.write(data)
        n += 1; total += len(data)

json.dump({
    "source": "ESA WorldCover 2021 v200",
    "tileDeg": TILE_DEG, "tilePx": TILE_PX, "pxDeg": PX_DEG,
    "lat": [LAT0, LAT1], "lon": [LON0, LON1],
    "latIdx": [lat_i0, lat_i1], "lonIdx": [lon_i0, lon_i1],
    "codes": {"0": "open", "1": "forest", "2": "water", "3": "built", "4": "nodata"},
}, open(os.path.join(out, "index.json"), "w"), indent=1)
print(f"wrote {n} tiles, {total / 1e6:.1f} MB gzipped, to {os.path.abspath(out)}")
np.save(os.path.join(os.path.dirname(__file__), "wc-region.npy"), region)  # for wc-check.py, not committed
