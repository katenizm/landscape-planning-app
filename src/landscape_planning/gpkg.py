"""Минимальное чтение геометрий GeoPackage без geopandas и fiona.

Нужно только для подготовки статического набора данных: прочитать границу
территории и, при необходимости, проверить геометрию ячеек. Формат GeoPackage
содержит стандартный WKB-блок после заголовка; здесь поддерживаются Polygon и
MultiPolygon без Z/M.
"""

from __future__ import annotations

import sqlite3
import struct
from pathlib import Path
from typing import Iterable, Sequence

Point = tuple[float, float]
Ring = list[Point]
Polygon = list[Ring]


def _envelope_size(flags: int) -> int:
    code = (flags >> 1) & 0x07
    sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
    if code not in sizes:
        raise ValueError(f"Неизвестный тип конверта GeoPackage: {code}.")
    return sizes[code]


def _read_polygon(blob: bytes, offset: int, byte_order: str) -> tuple[Polygon, int]:
    ring_count = struct.unpack_from(byte_order + "I", blob, offset)[0]
    offset += 4
    rings: Polygon = []
    for _ in range(ring_count):
        point_count = struct.unpack_from(byte_order + "I", blob, offset)[0]
        offset += 4
        points: Ring = []
        for _ in range(point_count):
            x, y = struct.unpack_from(byte_order + "dd", blob, offset)
            points.append((float(x), float(y)))
            offset += 16
        rings.append(points)
    return rings, offset


def parse_gpkg_geometry(blob: bytes) -> list[Polygon]:
    """Разобрать BLOB GeoPackage и вернуть список полигонов."""

    if len(blob) < 8 or blob[:2] != b"GP":
        raise ValueError("BLOB не является геометрией GeoPackage.")
    flags = blob[3]
    offset = 8 + _envelope_size(flags)
    if offset + 5 > len(blob):
        raise ValueError("Обрезанный заголовок WKB.")
    byte_order = "<" if blob[offset] == 1 else ">"
    offset += 1
    raw_type = struct.unpack_from(byte_order + "I", blob, offset)[0]
    offset += 4

    # EWKB может добавлять флаги SRID/Z/M в старшие биты.
    geometry_type = raw_type & 0xFF
    if geometry_type == 3:
        rings, offset = _read_polygon(blob, offset, byte_order)
        return [rings]
    if geometry_type == 6:
        polygon_count = struct.unpack_from(byte_order + "I", blob, offset)[0]
        offset += 4
        polygons: list[Polygon] = []
        for _ in range(polygon_count):
            child_order = "<" if blob[offset] == 1 else ">"
            offset += 1
            child_type = struct.unpack_from(child_order + "I", blob, offset)[0] & 0xFF
            offset += 4
            if child_type != 3:
                raise ValueError(
                    f"В MultiPolygon ожидался Polygon, получен тип {child_type}."
                )
            rings, offset = _read_polygon(blob, offset, child_order)
            polygons.append(rings)
        return polygons
    raise ValueError(f"Неподдерживаемый тип WKB: {geometry_type}.")


def read_gpkg_geometries(
    path: str | Path,
    layer: str,
    *,
    column: str = "geom",
) -> list[list[Polygon]]:
    """Прочитать все геометрии слоя GeoPackage."""

    connection = sqlite3.connect(str(path))
    try:
        rows = connection.execute(
            f'SELECT "{column}" FROM "{layer}" WHERE "{column}" IS NOT NULL'
        ).fetchall()
    finally:
        connection.close()
    return [parse_gpkg_geometry(row[0]) for row in rows]


def read_first_geometry(
    path: str | Path,
    layer: str,
    *,
    column: str = "geom",
) -> list[Polygon]:
    """Прочитать первую непустую геометрию слоя."""

    connection = sqlite3.connect(str(path))
    try:
        row = connection.execute(
            f'SELECT "{column}" FROM "{layer}" WHERE "{column}" IS NOT NULL LIMIT 1'
        ).fetchone()
    finally:
        connection.close()
    if not row:
        raise ValueError(f"В слое {layer!r} нет геометрий.")
    return parse_gpkg_geometry(row[0])


def _point_segment_distance(point: Point, start: Point, end: Point) -> float:
    px, py = point
    ax, ay = start
    bx, by = end
    dx = bx - ax
    dy = by - ay
    if dx == 0 and dy == 0:
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    cx = ax + t * dx
    cy = ay + t * dy
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5


def _douglas_peucker(points: Sequence[Point], tolerance: float) -> list[Point]:
    if len(points) <= 2:
        return list(points)
    start = points[0]
    end = points[-1]
    max_distance = -1.0
    index = 0
    for i in range(1, len(points) - 1):
        distance = _point_segment_distance(points[i], start, end)
        if distance > max_distance:
            max_distance = distance
            index = i
    if max_distance <= tolerance:
        return [start, end]
    left = _douglas_peucker(points[: index + 1], tolerance)
    right = _douglas_peucker(points[index:], tolerance)
    return left[:-1] + right


def simplify_ring(points: Iterable[Point], tolerance: float) -> Ring:
    """Упростить замкнутое кольцо, сохранив замыкание."""

    ring = list(points)
    if len(ring) < 4:
        return ring
    closed = ring[0] == ring[-1]
    if closed:
        ring = ring[:-1]
    if len(ring) < 3:
        return ring + [ring[0]] if ring else ring
    simplified = _douglas_peucker(ring + [ring[0]], tolerance)
    if simplified[0] != simplified[-1]:
        simplified.append(simplified[0])
    if len(simplified) < 4:
        return ring + [ring[0]]
    return simplified


def simplify_polygons(
    polygons: Iterable[Polygon],
    tolerance: float,
) -> list[Polygon]:
    """Упростить все кольца полигонов."""

    return [
        [simplify_ring(ring, tolerance) for ring in polygon]
        for polygon in polygons
    ]


def ring_signed_area(ring: Sequence[Point]) -> float:
    """Площадь кольца со знаком в единицах координат."""

    if len(ring) < 3:
        return 0.0
    return 0.5 * sum(
        ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
        for i in range(len(ring) - 1)
    )


def polygons_area(polygons: Iterable[Polygon]) -> float:
    """Площадь набора полигонов с учётом отверстий."""

    total = 0.0
    for polygon in polygons:
        if not polygon:
            continue
        total += abs(ring_signed_area(polygon[0]))
        for hole in polygon[1:]:
            total -= abs(ring_signed_area(hole))
    return total
