import struct
import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from landscape_planning.gpkg import (  # noqa: E402
    parse_gpkg_geometry,
    polygons_area,
    ring_signed_area,
    simplify_polygons,
    simplify_ring,
)


def wkb_polygon(rings, byte_order="<"):
    order = 1 if byte_order == "<" else 0
    result = bytes([order]) + struct.pack(byte_order + "I", 3)
    result += struct.pack(byte_order + "I", len(rings))
    for ring in rings:
        result += struct.pack(byte_order + "I", len(ring))
        for x, y in ring:
            result += struct.pack(byte_order + "dd", x, y)
    return result


def gpkg_blob(wkb, flags=1):
    return b"GP" + bytes([0, flags]) + struct.pack("<i", 32648) + wkb


class GpkgTest(unittest.TestCase):
    def test_parse_polygon(self):
        ring = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0), (0.0, 0.0)]
        polygons = parse_gpkg_geometry(gpkg_blob(wkb_polygon([ring])))
        self.assertEqual(len(polygons), 1)
        self.assertEqual(polygons[0][0], ring)
        self.assertAlmostEqual(polygons_area(polygons), 100.0)

    def test_parse_multipolygon(self):
        first = [(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0), (0.0, 0.0)]
        second = [(5.0, 5.0), (7.0, 5.0), (7.0, 7.0), (5.0, 7.0), (5.0, 5.0)]
        wkb = b"\x01" + struct.pack("<I", 6) + struct.pack("<I", 2)
        wkb += wkb_polygon([first])
        wkb += wkb_polygon([second])
        polygons = parse_gpkg_geometry(gpkg_blob(wkb))
        self.assertEqual(len(polygons), 2)
        self.assertAlmostEqual(polygons_area(polygons), 8.0)

    def test_parse_big_endian_polygon(self):
        ring = [(0.0, 0.0), (3.0, 0.0), (3.0, 4.0), (0.0, 4.0), (0.0, 0.0)]
        polygons = parse_gpkg_geometry(gpkg_blob(wkb_polygon([ring], ">")))
        self.assertAlmostEqual(polygons_area(polygons), 12.0)

    def test_rejects_non_gpkg_blob(self):
        with self.assertRaises(ValueError):
            parse_gpkg_geometry(b"PK\x03\x04")

    def test_area_with_hole(self):
        outer = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0), (0.0, 0.0)]
        hole = [(4.0, 4.0), (4.0, 6.0), (6.0, 6.0), (6.0, 4.0), (4.0, 4.0)]
        self.assertAlmostEqual(ring_signed_area(outer), 100.0)
        self.assertAlmostEqual(ring_signed_area(hole), -4.0)
        self.assertAlmostEqual(polygons_area([[outer, hole]]), 96.0)

    def test_simplify_ring_keeps_closure_and_shape(self):
        ring = [
            (0.0, 0.0),
            (5.0, 0.0),
            (10.0, 0.0),
            (10.0, 5.0),
            (10.0, 10.0),
            (5.0, 10.0),
            (0.0, 10.0),
            (0.0, 5.0),
            (0.0, 0.0),
        ]
        simplified = simplify_ring(ring, 1.0)
        self.assertEqual(simplified[0], simplified[-1])
        self.assertLessEqual(len(simplified), len(ring))
        self.assertAlmostEqual(polygons_area([[simplified]]), 100.0)

    def test_simplify_polygons_preserves_outer_ring(self):
        outer = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0), (0.0, 0.0)]
        simplified = simplify_polygons([[outer]], 0.5)
        self.assertEqual(len(simplified), 1)
        self.assertEqual(simplified[0][0][0], simplified[0][0][-1])


if __name__ == "__main__":
    unittest.main()
