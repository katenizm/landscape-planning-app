"""Подготовка и проверка данных для статического приложения сценарной оценки.

Пакет не выполняет геообработку в браузере. Он читает сохранённые результаты
технической апробации, проверяет расчёт и формирует компактный JSON для
статического сайта. Все численные параметры индекса имеют демонстрационный
статус НИР-2.
"""

from .model import (  # noqa: F401
    COMBINED_MODES,
    EFFECTIVE_NORM_ORDER,
    LANDSCAPE_MODES,
    NORM_STATUSES,
    SCENARIO_DATA_STATUSES,
    classify_landscape,
    combine_mode,
    effective_norm_status,
    expected_scenario_status,
    normalize,
    weighted_index,
)
