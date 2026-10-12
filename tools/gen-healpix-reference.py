#!/usr/bin/env python3
"""生成 HEALPix NESTED 参考向量，供 public/src/hips/healpix.js 的 Node 测试比对。

参考实现：astropy-healpix 2.0.1（BSD-3-Clause）。
安装方式（不污染系统 Python）：
    python3 -m pip install --target ./tools/pyref astropy-healpix
运行：
    PYTHONPATH=./tools/pyref python3 tools/gen-healpix-reference.py
输出：
    test/reference/healpix-ref.json
"""
import json
import math
import os

import numpy as np
import astropy.units as u
from astropy_healpix import HEALPix

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "test", "reference", "healpix-ref.json")


def lonlat(px, nside):
    hp = HEALPix(nside=nside, order="nested")
    lon, lat = hp.healpix_to_lonlat(np.asarray(px, dtype=np.int64))
    return np.degrees(lon.value), np.degrees(lat.value)


def to_pix(lon_deg, lat_deg, nside):
    hp = HEALPix(nside=nside, order="nested")
    px = hp.lonlat_to_healpix(
        u.Quantity(np.asarray(lon_deg, dtype=float), u.deg),
        u.Quantity(np.asarray(lat_deg, dtype=float), u.deg),
    )
    return [int(v) for v in np.atleast_1d(px)]


vectors = []
for order in range(0, 10):
    nside = 2 ** order
    npix = 12 * nside * nside
    # 每个 order 取样：前若干、后若干、等距抽样、以及 10000 目录边界附近
    picks = set()
    for k in range(0, min(6, npix)):
        picks.add(k)
    for k in range(max(0, npix - 6), npix):
        picks.add(k)
    step = max(1, npix // 37)
    for k in range(0, npix, step):
        picks.add(k)
    for base in (9999, 10000, 10001, 20000, 99999, 100000, 100001):
        if base < npix:
            picks.add(base)
        if base - 1 < npix and base - 1 >= 0:
            picks.add(base - 1)
    picks = sorted(picks)
    lon, lat = lonlat(picks, nside)
    for k, lo, la in zip(picks, lon, lat):
        vectors.append(
            {
                "order": order,
                "nside": nside,
                "npix": int(k),
                "lon": float(lo),
                "lat": float(la),
                "path": "Norder%d/Dir%d/Npix%d.png"
                % (order, (k // 10000) * 10000, k),
            }
        )

# 地标：独立来源的月面经纬度（见 docs/validation/ 坐标说明），验证 经纬度→瓦片 的方向
LANDMARKS = [
    # name, lon(东经为正), lat, 来源
    ("Tycho", -11.36, -43.31, "IAU 行星命名系统 / LROC"),
    ("Copernicus", -20.08, 9.62, "IAU 行星命名系统 / LROC"),
    ("Mare Crisium", 59.1, 17.0, "IAU 行星命名系统"),
    ("Tycho_antipode", 168.64, 43.31, "第谷对跖点（用于另一半球检查）"),
    ("South Pole", 0.0, -90.0, "极点"),
    ("North Pole", 0.0, 90.0, "极点"),
    ("DateLine", 180.0, 0.0, "±180 度接缝"),
    ("DateLineW", -180.0, 0.0, "±180 度接缝"),
]
landmark_pix = {}
for order in (3, 5, 7, 9):
    nside = 2 ** order
    for name, lo, la, _src in LANDMARKS:
        px = to_pix(lo, la, nside)[0]
        clon, clat = lonlat([px], nside)
        landmark_pix.setdefault(name, {})[str(order)] = {
            "lon": lo,
            "lat": la,
            "npix": px,
            "center_lon": float(clon[0]),
            "center_lat": float(clat[0]),
        }

# 瓦片四角：用 astropy-healpix 的 boundaries_healpix 独立算出同一批瓦片的角点
corner_cases = []
for order, npix_list in (
    (0, [0, 1, 5, 11]),
    (1, [0, 1, 2, 23, 24, 47]),
    (3, [0, 5, 383, 384, 767]),
    (5, [0, 1, 6143, 6144, 12287]),
    (9, [0, 1, 3145727]),
):
    nside = 2 ** order
    hp = HEALPix(nside=nside, order="nested")
    for npix in npix_list:
        blon, blat = hp.boundaries_lonlat(npix, step=1)  # 各 (4,) 角点
        corner_cases.append(
            {
                "order": order,
                "nside": nside,
                "npix": npix,
                "corners_lon": [float(v) for v in np.ravel(np.degrees(blon.value))],
                "corners_lat": [float(v) for v in np.ravel(np.degrees(blat.value))],
            }
        )

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    json.dump(
        {
            "source": "astropy-healpix 2.0.1 (BSD-3-Clause), order='nested'",
            "generated_by": "tools/gen-healpix-reference.py",
            "vectors": vectors,
            "landmarks": landmark_pix,
            "corners": corner_cases,
        },
        f,
        indent=1,
    )
print("wrote", OUT, "vectors:", len(vectors), "corner_cases:", len(corner_cases))
