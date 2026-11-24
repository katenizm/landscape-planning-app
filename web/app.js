(() => {
  "use strict";

  const DATA = window.LANDSCAPE_DATA;
  if (!DATA || !DATA.meta || !Array.isArray(DATA.cells)) {
    document.getElementById("main").innerHTML =
      '<div class="panel"><h2>Не удалось загрузить данные</h2><p>Проверьте, что файл <code>data/data.js</code> существует и не повреждён.</p></div>';
    return;
  }

  const META = DATA.meta;
  const CELLS = DATA.cells;
  const BY_ID = new Map(CELLS.map((cell) => [cell.id, cell]));
  const SCENARIOS = META.scenarios;
  const SCENARIO_KEYS = SCENARIOS.map((scenario) => scenario.key);
  const SCENARIO_INDEX = Object.fromEntries(
    SCENARIOS.map((scenario, index) => [scenario.key, index])
  );
  const SCENARIO_BY_KEY = Object.fromEntries(
    SCENARIOS.map((scenario) => [scenario.key, scenario])
  );

  const invert = (object) =>
    Object.fromEntries(Object.entries(object).map(([key, value]) => [value, key]));

  const NORM_NAMES = invert(META.codes.norm);
  const LANDSCAPE_NAMES = invert(META.codes.landscape);
  const MODE_NAMES = invert(META.codes.mode);
  const STATUS_NAMES = invert(META.codes.status);

  const NORM_ORDER = [
    "prohibited",
    "unclassified",
    "not_assessed",
    "conditional",
    "allowed",
    "no_known_restrictions",
  ];
  const MODE_ORDER = [
    "intensive_development",
    "extensive_development",
    "limited_development",
    "preservation",
    "normative_review_required",
    "scenario_excluded",
    "landscape_data_missing",
    "normative_data_missing",
    "not_calculated",
  ];
  const LANDSCAPE_ORDER = [
    "intensive_development",
    "extensive_development",
    "limited_development",
    "preservation",
  ];

  const CRITERIA = META.criteria;
  const CRITERION_INDEX = Object.fromEntries(
    CRITERIA.map((criterion, index) => [criterion.key, index])
  );

  const state = {
    view: "map",
    scenario: SCENARIO_KEYS[0],
    layer: "recommended",
    rawCriterion: "slope",
    selectedId: null,
    compare: new Set(),
    searchResults: [],
    searchStats: null,
    experimentView: "C",
    dimUncalculated: false,
    mapView: null,
    suppressClick: false,
    hoverId: null,
  };

  const els = {
    map: document.getElementById("map"),
    mapCanvas: document.getElementById("mapCanvas"),
    mapTooltip: document.getElementById("mapTooltip"),
    mapLegend: document.getElementById("mapLegend"),
    mapLayerTitle: document.getElementById("mapLayerTitle"),
    mapLayerSubtitle: document.getElementById("mapLayerSubtitle"),
    mapFootnote: document.getElementById("mapFootnote"),
    scaleLabel: document.getElementById("scaleLabel"),
    scenarioSwitch: document.getElementById("scenarioSwitch"),
    layerSwitch: document.getElementById("layerSwitch"),
    rawCriterionField: document.getElementById("rawCriterionField"),
    rawCriterion: document.getElementById("rawCriterion"),
    dimUncalculated: document.getElementById("dimUncalculated"),
    cellPanel: document.getElementById("cellPanel"),
    cellLookup: document.getElementById("cellLookup"),
    cellLookupHint: document.getElementById("cellLookupHint"),
    compareCount: document.getElementById("compareCount"),
    compareCells: document.getElementById("compareCells"),
    scenarioSummary: document.getElementById("scenarioSummary"),
    compareCellLabel: document.getElementById("compareCellLabel"),
    cellScenarioCompare: document.getElementById("cellScenarioCompare"),
    conflictSummary: document.getElementById("conflictSummary"),
    conflictExamples: document.getElementById("conflictExamples"),
    searchScenario: document.getElementById("searchScenario"),
    searchBoundary: document.getElementById("searchBoundary"),
    searchInside: document.getElementById("searchInside"),
    searchInsideValue: document.getElementById("searchInsideValue"),
    searchMaxSi: document.getElementById("searchMaxSi"),
    searchSummary: document.getElementById("searchSummary"),
    searchResults: document.getElementById("searchResults"),
    searchCount: document.getElementById("searchCount"),
    experimentDefinitions: document.getElementById("experimentDefinitions"),
    experimentScenarioLabel: document.getElementById("experimentScenarioLabel"),
    experimentCounts: document.getElementById("experimentCounts"),
    experimentComparison: document.getElementById("experimentComparison"),
    experimentTop: document.getElementById("experimentTop"),
    experimentTopNote: document.getElementById("experimentTopNote"),
    experimentReviewCount: document.getElementById("experimentReviewCount"),
    experimentReview: document.getElementById("experimentReview"),
    experimentCross: document.getElementById("experimentCross"),
    experimentOverlap: document.getElementById("experimentOverlap"),
    experimentConflicts: document.getElementById("experimentConflicts"),
    experimentReport: document.getElementById("experimentReport"),
    criteriaTable: document.getElementById("criteriaTable"),
    weightsTable: document.getElementById("weightsTable"),
    normStatusTable: document.getElementById("normStatusTable"),
    modeTable: document.getElementById("modeTable"),
    syntheticCheck: document.getElementById("syntheticCheck"),
    sourcesTable: document.getElementById("sourcesTable"),
    limitationsList: document.getElementById("limitationsList"),
    contradictionsList: document.getElementById("contradictionsList"),
    datasetInfo: document.getElementById("datasetInfo"),
    dataSourcesTable: document.getElementById("dataSourcesTable"),
    toast: document.getElementById("toast"),
  };

  const numberFormat = new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 3,
  });
  const integerFormat = new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 0,
  });

  const escapeHtml = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  const fmt = (value, digits = 2) => {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
      return "—";
    }
    return Number(value).toLocaleString("ru-RU", {
      maximumFractionDigits: digits,
      minimumFractionDigits: 0,
    });
  };

  const fmtInt = (value) => integerFormat.format(Number(value || 0));
  const fmtPercent = (value, digits = 1) =>
    value === null || value === undefined
      ? "—"
      : `${(Number(value) * 100).toFixed(digits)}%`;

  const fmtArea = (insideShare) => {
    const areaM2 = Number(insideShare) * META.grid.cell_size_m ** 2;
    if (areaM2 >= 10000) {
      return `${fmt(areaM2 / 10000, 1)} га`;
    }
    return `${fmt(areaM2, 0)} м²`;
  };

  const decode = (cell, scenarioKey) => {
    const record = cell.s[SCENARIO_INDEX[scenarioKey]];
    return {
      effectiveNorm: NORM_NAMES[record[0]],
      norm: NORM_NAMES[record[1]],
      shares: {
        prohibited: record[2],
        conditional: record[3],
        allowed: record[4],
        unclassified: record[5],
        no_known_restrictions: record[6],
        not_assessed: record[7],
      },
      si: record[8],
      landscape: record[9] === null ? null : LANDSCAPE_NAMES[record[9]],
      recommended: MODE_NAMES[record[10]],
      status: STATUS_NAMES[record[11]],
      normalized: record[12],
      zones: record[13],
      own: Boolean(record[14]),
      ownStatus: record[15],
    };
  };

  const normLabel = (name) => META.norm_statuses[name]?.label || name;
  const normColor = (name) => META.norm_statuses[name]?.color || "#e2e8f0";
  const modeLabel = (name) => META.modes[name]?.label || name;
  const modeColor = (name) => META.modes[name]?.color || "#e2e8f0";
  const scenarioLabel = (key) => SCENARIO_BY_KEY[key]?.label || key;
  const zoneDisplayId = (id) =>
    String(id || "").replace(
      /__(?:housing|industrial|recreation_tourism|transport_infrastructure)$/,
      ""
    );

  const flagBadges = (flags) => {
    if (!flags || !flags.length) return "";
    return flags
      .map(
        (flag) =>
          `<span class="flag flag-${escapeHtml(flag.replaceAll(" ", "_"))}">${escapeHtml(flag)}</span>`
      )
      .join("");
  };

  const recordFlags = (cell, scenarioKey) => {
    const record = decode(cell, scenarioKey);
    const flags = [];
    if (record.effectiveNorm === "prohibited") flags.push("R3");
    if (record.effectiveNorm === "unclassified") flags.push("R2");
    if (record.effectiveNorm === "not_assessed") flags.push("NO_NORM");
    if (record.effectiveNorm === "conditional") flags.push("COND");
    if (record.status !== "calculated") flags.push("NOT_CALCULATED");
    return flags;
  };

  const statusPill = (name, type = "mode") => {
    const color = type === "norm" ? normColor(name) : modeColor(name);
    const label = type === "norm" ? normLabel(name) : modeLabel(name);
    return `<span class="status-pill" style="background:${color}22;color:#17212b"><span class="swatch" style="background:${color}"></span>${escapeHtml(label)}</span>`;
  };

  const swatch = (color) =>
    `<span class="swatch" style="background:${escapeHtml(color)}"></span>`;

  const tableWrap = (tableHtml, className = "") =>
    `<div class="table-wrap ${className}">${tableHtml}</div>`;

  const showToast = (message) => {
    els.toast.textContent = message;
    els.toast.hidden = false;
    window.clearTimeout(showToast.timeout);
    showToast.timeout = window.setTimeout(() => {
      els.toast.hidden = true;
    }, 2800);
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast("Ссылка скопирована.");
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      showToast("Ссылка скопирована.");
    }
  };

  const currentScenario = () => SCENARIO_BY_KEY[state.scenario];
  const currentScenarioStats = () => currentScenario().stats;

  const scenarioRecord = (cell, key = state.scenario) => decode(cell, key);

  const modeCountsForLayer = () => {
    const counts = currentScenarioStats().recommended_counts || {};
    return MODE_ORDER.filter((name) => counts[name]).map((name) => [
      name,
      counts[name],
    ]);
  };

  const effectiveNormCounts = () =>
    currentScenarioStats().effective_norm_counts || {};

  const landscapeCounts = () => currentScenarioStats().landscape_counts || {};

  const conflictCounts = (() => {
    let cache = null;
    return () => {
      if (cache) return cache;
      const counts = { none: 0, 2: 0, 3: 0, 4: 0 };
      for (const cell of CELLS) {
        const distinct = new Set();
        for (const key of SCENARIO_KEYS) {
          const record = decode(cell, key);
          if (record.status === "calculated") {
            distinct.add(record.recommended);
          } else if (record.status === "normatively_prohibited") {
            distinct.add("scenario_excluded");
          } else if (record.status === "normative_review_required") {
            distinct.add("normative_review_required");
          } else if (record.status === "landscape_data_missing") {
            distinct.add("landscape_data_missing");
          } else if (record.status === "normative_data_missing") {
            distinct.add("normative_data_missing");
          }
        }
        const size = distinct.size;
        if (size <= 1) counts.none += 1;
        else if (size >= 4) counts[4] += 1;
        else counts[size] += 1;
      }
      cache = counts;
      return counts;
    };
  })();

  const conflictColor = (cell) => {
    const distinct = new Set();
    for (const key of SCENARIO_KEYS) {
      const record = decode(cell, key);
      if (record.status === "calculated") distinct.add(record.recommended);
      else if (record.status === "normatively_prohibited") distinct.add("scenario_excluded");
      else if (record.status === "normative_review_required") distinct.add("normative_review_required");
      else if (record.status === "landscape_data_missing") distinct.add("landscape_data_missing");
      else if (record.status === "normative_data_missing") distinct.add("normative_data_missing");
    }
    if (distinct.size <= 1) return "#e2e8f0";
    if (distinct.size === 2) return "#f4b1bd";
    if (distinct.size === 3) return "#df7eaa";
    return "#be405a";
  };

  const RAW_PALETTES = {
    slope: ["#dce8fc", "#8bb8ee", "#dd91c1", "#bb405c"],
    hydro: ["#e4edfc", "#a8c9f3", "#6d99db", "#254d9b"],
    natural: ["#e4e9fc", "#aabced", "#a87fca", "#70478e"],
    development: ["#fce4ed", "#efa8c4", "#9e9bd5", "#345da9"],
  };

  const hexToRgb = (hex) => {
    const normalized = hex.replace("#", "");
    const value = parseInt(normalized, 16);
    return {
      r: (value >> 16) & 255,
      g: (value >> 8) & 255,
      b: value & 255,
    };
  };

  const rgbToHex = (rgb) =>
    `#${[rgb.r, rgb.g, rgb.b]
      .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0"))
      .join("")}`;

  const paletteColor = (palette, ratio) => {
    const t = Math.max(0, Math.min(1, ratio));
    const scaled = t * (palette.length - 1);
    const index = Math.min(palette.length - 2, Math.floor(scaled));
    const local = scaled - index;
    const a = hexToRgb(palette[index]);
    const b = hexToRgb(palette[index + 1]);
    return rgbToHex({
      r: a.r + (b.r - a.r) * local,
      g: a.g + (b.g - a.g) * local,
      b: a.b + (b.b - a.b) * local,
    });
  };

  const rawColor = (cell, criterionKey) => {
    const criterion = CRITERIA[CRITERION_INDEX[criterionKey]];
    const value = cell.k[CRITERION_INDEX[criterionKey]];
    if (value === null || value === undefined) return "#e2e8f0";
    const ratio = (Number(value) - criterion.lower) / (criterion.upper - criterion.lower);
    return paletteColor(RAW_PALETTES[criterionKey], ratio);
  };

  const colorForCell = (cell) => {
    if (state.layer === "recommended") {
      return modeColor(decode(cell, state.scenario).recommended);
    }
    if (state.layer === "norm") {
      return normColor(decode(cell, state.scenario).effectiveNorm);
    }
    if (state.layer === "landscape") {
      const landscape = decode(cell, state.scenario).landscape;
      return landscape ? modeColor(landscape) : "#e2e8f0";
    }
    if (state.layer === "raw") {
      return rawColor(cell, state.rawCriterion);
    }
    return conflictColor(cell);
  };

  const buildBoundaryPath = (boundary) => {
    const parts = [];
    for (const polygon of boundary || []) {
      for (const ring of polygon) {
        if (!ring || ring.length < 2) continue;
        const [first, ...rest] = ring;
        parts.push(`M ${first[0]} ${first[1]}`);
        for (const point of rest) {
          parts.push(`L ${point[0]} ${point[1]}`);
        }
        parts.push("Z");
      }
    }
    return parts.join(" ");
  };

  const fullView = () => ({
    x: 0,
    y: 0,
    w: META.grid.width_m,
    h: META.grid.height_m,
  });

  const clampView = (view) => {
    const full = fullView();
    const minWidth = full.w * 0.08;
    const width = Math.max(minWidth, Math.min(full.w, view.w));
    const height = width * (full.h / full.w);
    const x = Math.max(0, Math.min(full.w - width, view.x));
    const y = Math.max(0, Math.min(full.h - height, view.y));
    return { x, y, w: width, h: height };
  };

  const applyView = () => {
    if (!state.mapView) state.mapView = fullView();
    const view = clampView(state.mapView);
    state.mapView = view;
    els.map.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
    updateScale(view);
  };

  const updateScale = (view) => {
    const pixelWidth = els.map.getBoundingClientRect().width || 800;
    const metersPerPixel = view.w / pixelWidth;
    const targetMeters = metersPerPixel * 52;
    const exponent = Math.floor(Math.log10(Math.max(1, targetMeters)));
    const base = 10 ** exponent;
    const candidates = [1, 2, 5, 10].map((value) => value * base);
    const distance = candidates.reduce((best, value) =>
      Math.abs(value - targetMeters) < Math.abs(best - targetMeters) ? value : best
    );
    els.scaleLabel.textContent =
      distance >= 1000 ? `${fmt(distance / 1000, distance >= 10000 ? 0 : 1)} км` : `${fmt(distance, 0)} м`;
  };

  const zoomView = (factor, centerX, centerY) => {
    const view = state.mapView || fullView();
    const full = fullView();
    const cx = centerX ?? view.x + view.w / 2;
    const cy = centerY ?? view.y + view.h / 2;
    const newWidth = Math.max(full.w * 0.08, Math.min(full.w, view.w / factor));
    const newHeight = newWidth * (full.h / full.w);
    const x = cx - ((cx - view.x) / view.w) * newWidth;
    const y = cy - ((cy - view.y) / view.h) * newHeight;
    state.mapView = clampView({ x, y, w: newWidth, h: newHeight });
    applyView();
  };

  const resetView = () => {
    state.mapView = fullView();
    applyView();
  };

  const focusCell = (cell, widthMeters = 9000) => {
    const size = META.grid.cell_size_m;
    const centerX = (cell.c - 0.5) * size;
    const centerY = (META.grid.rows - cell.r + 0.5) * size;
    const width = Math.min(META.grid.width_m, Math.max(widthMeters, size * 6));
    state.mapView = clampView({
      x: centerX - width / 2,
      y: centerY - width / 2,
      w: width,
      h: width,
    });
    applyView();
  };

  const updateMapHighlights = () => {
    const topIds = new Set(state.searchResults.map((item) => item.cell.id));
    const rects = els.map.querySelectorAll(".cell");
    for (const rect of rects) {
      const id = rect.dataset.id;
      rect.classList.toggle("is-selected", id === state.selectedId);
      rect.classList.toggle("is-compared", state.compare.has(id));
      rect.classList.toggle("is-top", topIds.has(id));
      const cell = BY_ID.get(id);
      if (cell && state.dimUncalculated) {
        const record = decode(cell, state.scenario);
        const dim = !["intensive_development", "extensive_development", "limited_development", "preservation"].includes(record.recommended);
        rect.classList.toggle("is-dimmed", dim);
      } else {
        rect.classList.remove("is-dimmed");
      }
    }
  };

  const renderMap = () => {
    const svg = els.map;
    svg.innerHTML = "";
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.id = "mapSvgTitle";
    title.textContent = "Карта сетки сценарной оценки";
    const desc = document.createElementNS("http://www.w3.org/2000/svg", "desc");
    desc.id = "mapSvgDesc";
    desc.textContent =
      "Интерактивная схема ячеек 500 на 500 метров с цветовой легендой.";
    svg.append(title, desc);

    const size = META.grid.cell_size_m;
    const rows = META.grid.rows;
    const fragment = document.createDocumentFragment();
    const cellsGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
    for (const cell of CELLS) {
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", String((cell.c - 1) * size));
      rect.setAttribute("y", String((rows - cell.r) * size));
      rect.setAttribute("width", String(size));
      rect.setAttribute("height", String(size));
      rect.setAttribute("fill", colorForCell(cell));
      rect.setAttribute("class", "cell");
      rect.dataset.id = cell.id;
      cellsGroup.appendChild(rect);
    }
    fragment.appendChild(cellsGroup);

    const boundary = document.createElementNS("http://www.w3.org/2000/svg", "path");
    boundary.setAttribute("d", buildBoundaryPath(META.boundary));
    boundary.setAttribute("class", "boundary");
    boundary.setAttribute("fill-rule", "evenodd");
    fragment.appendChild(boundary);
    svg.appendChild(fragment);

    applyView();
    updateMapHighlights();
    renderMapMeta();
    renderLegend();
  };

  const renderMapMeta = () => {
    const scenario = currentScenario();
    const layerTitles = {
      recommended: "Рекомендуемый режим",
      norm: "Нормативный статус",
      landscape: "Ландшафтная чувствительность",
      raw: `Исходный критерий: ${CRITERIA[CRITERION_INDEX[state.rawCriterion]].short_label.toLowerCase()}`,
      conflict: "Расхождения сценариев",
    };
    els.mapLayerTitle.textContent = layerTitles[state.layer];
    els.mapLayerSubtitle.textContent = `${scenario.label} · демонстрационные параметры НИР-2`;
    const notes = {
      recommended: "Итог совмещения нормативного статуса и класса чувствительности. Запрет и проверка не компенсируются низким индексом.",
      norm: "Показан итоговый нормативный статус с учётом долей пересечения. no_known_restrictions не равно юридическому allowed.",
      landscape: "Класс ландшафтной чувствительности показан только для рассчитанных ячеек. Для R2 и R3 индекс не рассчитывается.",
      raw: "Физические значения критерия. Если сценарий не рассчитывался, значение может быть собрано из другого сценария; это не официальный результат сценария.",
      conflict: "Цвет показывает число различных режимов среди четырёх сценариев. Это не оценка допустимости.",
    };
    els.mapFootnote.textContent = notes[state.layer];
  };

  const renderLegend = () => {
    const parts = [];
    if (state.layer === "recommended") {
      for (const [name, count] of modeCountsForLayer()) {
        parts.push(
          `<span class="legend-item">${swatch(modeColor(name))}${escapeHtml(modeLabel(name))} <strong>${fmtInt(count)}</strong></span>`
        );
      }
    } else if (state.layer === "norm") {
      const counts = effectiveNormCounts();
      for (const name of NORM_ORDER) {
        if (!counts[name]) continue;
        parts.push(
          `<span class="legend-item">${swatch(normColor(name))}${escapeHtml(normLabel(name))} <strong>${fmtInt(counts[name])}</strong></span>`
        );
      }
    } else if (state.layer === "landscape") {
      const counts = landscapeCounts();
      for (const name of LANDSCAPE_ORDER) {
        if (!counts[name]) continue;
        parts.push(
          `<span class="legend-item">${swatch(modeColor(name))}${escapeHtml(modeLabel(name))} <strong>${fmtInt(counts[name])}</strong></span>`
        );
      }
      const notCalculated = currentScenarioStats().total - (currentScenarioStats().calculated || 0);
      if (notCalculated) {
        parts.push(
          `<span class="legend-item">${swatch("#e2e8f0")}Не рассчитано <strong>${fmtInt(notCalculated)}</strong></span>`
        );
      }
    } else if (state.layer === "raw") {
      const criterion = CRITERIA[CRITERION_INDEX[state.rawCriterion]];
      const palette = RAW_PALETTES[state.rawCriterion];
      const gradient = `linear-gradient(90deg, ${palette.join(", ")})`;
      parts.push(
        `<span class="legend-gradient"><span>${fmt(criterion.lower, 1)}</span><span class="gradient-bar" style="background:${gradient}"></span><span>${fmt(criterion.upper, 1)} ${escapeHtml(criterion.unit)}</span></span>`
      );
      parts.push(
        `<span class="legend-item">${swatch("#e2e8f0")}Нет значения</span>`
      );
    } else if (state.layer === "conflict") {
      const counts = conflictCounts();
      parts.push(
        `<span class="legend-item">${swatch("#e2e8f0")}Нет расхождений <strong>${fmtInt(counts.none)}</strong></span>`
      );
      for (const [count, color] of [
        [2, "#f4b1bd"],
        [3, "#df7eaa"],
        [4, "#be405a"],
      ]) {
        parts.push(
          `<span class="legend-item">${swatch(color)}${count} режима <strong>${fmtInt(counts[count])}</strong></span>`
        );
      }
    }
    els.mapLegend.innerHTML = parts.join("");
  };

  const renderScenarioSwitch = () => {
    els.scenarioSwitch.innerHTML = SCENARIOS.map((scenario) => {
      const stats = scenario.stats;
      return `<button type="button" class="scenario-card ${scenario.key === state.scenario ? "is-active" : ""}" data-scenario="${scenario.key}">
        <span class="scenario-name"><span class="scenario-dot" style="background:${scenario.color}"></span>${escapeHtml(scenario.label)}</span>
        <span class="scenario-meta">рассчитано ${fmtInt(stats.calculated)} · запрет ${fmtInt(stats.excluded)} · проверка ${fmtInt(stats.review)}</span>
      </button>`;
    }).join("");
    els.scenarioSwitch.querySelectorAll("[data-scenario]").forEach((button) => {
      button.addEventListener("click", () => setScenario(button.dataset.scenario));
    });
  };

  const renderSearchScenarioSelect = () => {
    els.searchScenario.innerHTML = SCENARIOS.map(
      (scenario) =>
        `<option value="${scenario.key}" ${scenario.key === state.scenario ? "selected" : ""}>${escapeHtml(scenario.label)}</option>`
    ).join("");
  };

  const shareRow = (label, value, color) => `
    <div class="share-row">
      <span>${escapeHtml(label)}</span>
      <span class="share-track"><span class="share-fill" style="width:${Math.max(0, Math.min(100, Number(value) * 100))}%;background:${color}"></span></span>
      <output>${fmtPercent(value)}</output>
    </div>`;

  const renderCellPanel = () => {
    if (!state.selectedId || !BY_ID.has(state.selectedId)) {
      const stats = currentScenarioStats();
      els.cellPanel.innerHTML = `<div class="cell-empty">
        <div class="panel-heading"><h3>Карточка ячейки</h3><span class="badge">${fmtInt(stats.total)}</span></div>
        <p>Кликните по ячейке на карте или найдите её по ID. Карточка покажет нормативный статус, исходные критерии, индекс и рекомендуемый режим.</p>
        <div class="metric-grid">
          <div class="metric-card"><span class="metric-label">Рассчитано</span><span class="metric-value">${fmtInt(stats.calculated)}</span></div>
          <div class="metric-card"><span class="metric-label">Запрет</span><span class="metric-value">${fmtInt(stats.excluded)}</span></div>
          <div class="metric-card"><span class="metric-label">Проверка R2</span><span class="metric-value">${fmtInt(stats.review)}</span></div>
          <div class="metric-card"><span class="metric-label">Нет данных</span><span class="metric-value">${fmtInt(stats.missing)}</span></div>
        </div>
        <p class="small-text">Сценарий: <strong>${escapeHtml(currentScenario().label)}</strong>. Все численные параметры индекса — демонстрационные.</p>
      </div>`;
      return;
    }

    const cell = BY_ID.get(state.selectedId);
    const record = scenarioRecord(cell);
    const scenario = currentScenario();
    const isCompared = state.compare.has(cell.id);
    const zones = record.zones
      .map((zoneId) => {
        const zone = META.zone_sources[zoneId] || { id: zoneId, source: "" };
        return `<li><span class="zone-id">${escapeHtml(zoneDisplayId(zone.id || zoneId))}</span>${escapeHtml(zone.source || "Источник не указан")}</li>`;
      })
      .slice(0, 8);

    const criteriaRows = CRITERIA.map((criterion, index) => {
      const raw = cell.k[index];
      const normalized = record.normalized ? record.normalized[index] : null;
      const weight = scenario.weights[index];
      const contribution = normalized === null ? null : normalized * weight;
      return `<tr>
        <td>${escapeHtml(criterion.label)}</td>
        <td class="num">${fmt(raw, criterion.key === "natural" ? 4 : criterion.key === "slope" ? 2 : 0)} ${escapeHtml(criterion.unit)}</td>
        <td class="num">${normalized === null ? "—" : fmt(normalized, 3)}</td>
        <td class="num">${fmt(weight, 3)}</td>
        <td class="num">${contribution === null ? "—" : fmt(contribution, 3)}</td>
      </tr>`;
    }).join("");

    const missingCriteria = CRITERIA.filter((_, index) => cell.k[index] === null).map(
      (criterion) => criterion.short_label
    );

    let calculationNotice = "";
    if (record.status === "calculated") {
      calculationNotice = `<div class="notice notice-info">
        <strong>Индекс рассчитан.</strong> Класс: ${escapeHtml(modeLabel(record.landscape))}. Итоговый режим: ${escapeHtml(modeLabel(record.recommended))}.
        ${record.effectiveNorm === "conditional" && record.landscape !== "preservation" ? "Для условного статуса класс понижен до ограниченного освоения." : ""}
      </div>`;
    } else if (record.status === "normatively_prohibited") {
      calculationNotice = `<div class="notice notice-danger">
        <strong>Сценарий исключён нормативным запретом.</strong> Доля запрета: ${fmtPercent(record.shares.prohibited)}.
        Индекс ландшафтной чувствительности не рассчитывается и не показывается, чтобы запрет нельзя было компенсировать низкой чувствительностью.
      </div>`;
    } else if (record.status === "normative_review_required") {
      calculationNotice = `<div class="notice notice-purple">
        <strong>Требуется нормативная проверка.</strong> Доля неопределённости: ${fmtPercent(record.shares.unclassified)}.
        Индекс не рассчитывается до завершения проверки, поэтому ячейка не участвует в рейтинге минимальной чувствительности.
      </div>`;
    } else if (record.status === "landscape_data_missing" || record.status === "normative_data_missing") {
      calculationNotice = `<div class="notice notice-warning">
        <strong>Расчёт не выполнен.</strong> ${missingCriteria.length ? `Не хватает критериев: ${escapeHtml(missingCriteria.join(", "))}.` : "Не хватает нормативных или ландшафтных данных."}
      </div>`;
    }

    const scenarioCompareRows = SCENARIO_KEYS.map((key) => {
      const item = scenarioRecord(cell, key);
      return `<tr class="${key === state.scenario ? "is-selected" : ""}">
        <td>${escapeHtml(scenarioLabel(key))}</td>
        <td>${escapeHtml(normLabel(item.effectiveNorm))}</td>
        <td class="num">${item.si === null ? "—" : fmt(item.si, 3)}</td>
        <td>${item.landscape ? escapeHtml(modeLabel(item.landscape)) : "—"}</td>
        <td>${escapeHtml(modeLabel(item.recommended))}</td>
        <td>${flagBadges(recordFlags(cell, key))}</td>
      </tr>`;
    }).join("");

    els.cellPanel.innerHTML = `
      <div class="cell-card-header">
        <div>
          <div class="cell-id">${escapeHtml(cell.id)}</div>
          <div class="cell-sub">строка ${cell.r}, столбец ${cell.c} · внутри территории ${fmtPercent(cell.in)} (${fmtArea(cell.in)})${cell.b ? " · граничная" : ""}</div>
        </div>
        ${statusPill(record.effectiveNorm, "norm")}
      </div>

      <div class="cell-section">
        <div class="mode-banner">
          <span class="mode-color" style="background:${modeColor(record.recommended)}"></span>
          <div>
            <strong>${escapeHtml(modeLabel(record.recommended))}</strong>
            <span>${escapeHtml(META.modes[record.recommended]?.description || "")}</span>
          </div>
        </div>
      </div>

      <div class="cell-section">
        <h4>Нормативный статус</h4>
        <dl class="kv-list">
          <dt>Итоговый статус</dt><dd>${escapeHtml(normLabel(record.effectiveNorm))}</dd>
          <dt>Доминирующий статус</dt><dd>${escapeHtml(normLabel(record.norm))}</dd>
          <dt>Доля запрета</dt><dd>${fmtPercent(record.shares.prohibited)}</dd>
          <dt>Доля условий</dt><dd>${fmtPercent(record.shares.conditional)}</dd>
          <dt>Доля неопределённости</dt><dd>${fmtPercent(record.shares.unclassified)}</dd>
          <dt>Доля без оценки</dt><dd>${fmtPercent(record.shares.not_assessed)}</dd>
        </dl>
        <div class="share-bars">
          ${shareRow("Запрет", record.shares.prohibited, normColor("prohibited"))}
          ${shareRow("Условия", record.shares.conditional, normColor("conditional"))}
          ${shareRow("Неопределённость", record.shares.unclassified, normColor("unclassified"))}
          ${shareRow("Без оценки", record.shares.not_assessed, normColor("not_assessed"))}
        </div>
        <p class="field-hint">Доли нормативных зон могут перекрываться и не обязаны суммироваться в 100%.</p>
        ${zones.length ? `<details><summary>Нормативные зоны (${record.zones.length})</summary><ul class="zone-list">${zones.join("")}</ul>${record.zones.length > 8 ? `<p class="field-hint">Показаны первые 8 из ${record.zones.length}.</p>` : ""}</details>` : '<p class="field-hint">Нормативные зоны для этой ячейки не указаны.</p>'}
      </div>

      <div class="cell-section">
        <h4>Исходные критерии</h4>
        ${!record.own && cell.ls === "complete" ? '<p class="field-hint">Для этого сценария ландшафтный этап не выполнялся; показаны физические значения, собранные из сценариев, где они были рассчитаны.</p>' : ""}
        ${cell.ls !== "complete" ? `<p class="field-hint">Полный набор физических критериев недоступен (${escapeHtml(cell.ls)}).</p>` : ""}
        <div class="table-wrap">
          <table class="formula-table">
            <thead><tr><th>Критерий</th><th>Значение</th><th>Нормализовано</th><th>Вес</th><th>Вклад</th></tr></thead>
            <tbody>${criteriaRows}</tbody>
          </table>
        </div>
      </div>

      ${calculationNotice}

      ${record.status === "calculated" ? `<div class="cell-section">
        <h4>Индекс</h4>
        <dl class="kv-list">
          <dt>Индекс чувствительности SI</dt><dd>${fmt(record.si, 4)}</dd>
          <dt>Класс чувствительности</dt><dd>${escapeHtml(modeLabel(record.landscape))}</dd>
          <dt>Рекомендуемый режим</dt><dd>${escapeHtml(modeLabel(record.recommended))}</dd>
        </dl>
      </div>` : ""}

      <div class="cell-section">
        <h4>Эта ячейка в четырёх сценариях</h4>
        ${tableWrap(`<table class="data-table"><thead><tr><th>Сценарий</th><th>Статус</th><th>SI</th><th>Класс</th><th>Режим</th><th>Флаги</th></tr></thead><tbody>${scenarioCompareRows}</tbody></table>`)}
      </div>

      <div class="inline-actions">
        <button type="button" class="button ${isCompared ? "button-secondary" : "button-primary"}" data-action="${isCompared ? "remove-compare" : "add-compare"}">${isCompared ? "Убрать из сравнения" : "Добавить к сравнению"}</button>
        <button type="button" class="button button-secondary" data-action="copy-cell-link">Ссылка на ячейку</button>
      </div>
    `;
  };

  const selectCell = (id, { switchView = false, focus = false } = {}) => {
    if (!BY_ID.has(id)) return;
    state.selectedId = id;
    if (focus) focusCell(BY_ID.get(id));
    if (switchView) setView("map", { scroll: true });
    renderCellPanel();
    updateMapHighlights();
    updateURL();
    if (switchView) renderCompare();
  };

  const addCompare = (id) => {
    if (!BY_ID.has(id)) return;
    if (state.compare.has(id)) {
      showToast("Ячейка уже добавлена к сравнению.");
      return;
    }
    if (state.compare.size >= 8) {
      showToast("Можно сравнить не более 8 ячеек.");
      return;
    }
    state.compare.add(id);
    renderCompare();
    updateMapHighlights();
    updateURL();
    showToast(`Ячейка ${id} добавлена к сравнению.`);
  };

  const removeCompare = (id) => {
    state.compare.delete(id);
    renderCompare();
    updateMapHighlights();
    updateURL();
  };

  const renderCompare = () => {
    els.compareCount.textContent = String(state.compare.size);
    const selected = Array.from(state.compare)
      .map((id) => BY_ID.get(id))
      .filter(Boolean);

    if (!selected.length) {
      els.compareCells.innerHTML =
        '<div class="empty-state">Добавьте ячейки кнопкой в карточке или Shift + кликом на карте.</div>';
    } else {
      const rows = selected.map((cell) => {
        const record = scenarioRecord(cell);
        return `<tr class="is-clickable" data-select-cell="${cell.id}">
          <td class="nowrap">${escapeHtml(cell.id)}</td>
          <td>${cell.r}/${cell.c}</td>
          <td>${escapeHtml(normLabel(record.effectiveNorm))}</td>
          <td class="num">${record.si === null ? "—" : fmt(record.si, 3)}</td>
          <td>${record.landscape ? escapeHtml(modeLabel(record.landscape)) : "—"}</td>
          <td>${escapeHtml(modeLabel(record.recommended))}</td>
          <td class="num">${fmt(cell.k[0], 1)}</td>
          <td class="num">${fmt(cell.k[1], 0)}</td>
          <td class="num">${fmt(cell.k[2], 2)}</td>
          <td class="num">${fmt(cell.k[3], 0)}</td>
          <td class="num">${fmtPercent(cell.in)}</td>
        </tr>`;
      }).join("");
      els.compareCells.innerHTML = tableWrap(
        `<table class="data-table"><thead><tr><th>Ячейка</th><th>Стр/стлб</th><th>Статус</th><th>SI</th><th>Класс</th><th>Режим</th><th>K1, °</th><th>K2, м</th><th>K3</th><th>K4, м</th><th>Внутри</th></tr></thead><tbody>${rows}</tbody></table>`
      );
    }

    const summaryRows = SCENARIOS.map((scenario) => {
      const stats = scenario.stats;
      return `<tr class="${scenario.key === state.scenario ? "is-selected" : ""}">
        <td>${escapeHtml(scenario.label)}</td>
        <td class="num">${fmtInt(stats.calculated)}</td>
        <td class="num">${fmtInt(stats.excluded)}</td>
        <td class="num">${fmtInt(stats.review)}</td>
        <td class="num">${fmtInt(stats.missing)}</td>
        <td class="num">${fmtInt(stats.recommended_counts.preservation || 0)}</td>
        <td class="num">${fmtInt(stats.recommended_counts.limited_development || 0)}</td>
        <td class="num">${fmtInt(stats.recommended_counts.extensive_development || 0)}</td>
        <td class="num">${fmtInt(stats.recommended_counts.intensive_development || 0)}</td>
      </tr>`;
    }).join("");
    els.scenarioSummary.innerHTML = tableWrap(
      `<table class="data-table"><thead><tr><th>Сценарий</th><th>Рассчитано</th><th>Запрет</th><th>R2</th><th>Нет данных</th><th>Сохранение</th><th>Огранич.</th><th>Экстенс.</th><th>Интенс.</th></tr></thead><tbody>${summaryRows}</tbody></table>`
    );

    const cell = state.selectedId ? BY_ID.get(state.selectedId) : null;
    els.compareCellLabel.textContent = cell ? cell.id : "ячейка не выбрана";
    if (!cell) {
      els.cellScenarioCompare.innerHTML =
        '<div class="empty-state">Выберите ячейку на карте или в таблице.</div>';
    } else {
      const rows = SCENARIO_KEYS.map((key) => {
        const record = scenarioRecord(cell, key);
        return `<tr class="is-clickable" data-select-cell="${cell.id}" data-scenario-target="${key}">
          <td>${escapeHtml(scenarioLabel(key))}</td>
          <td>${escapeHtml(normLabel(record.effectiveNorm))}</td>
          <td class="num">${record.si === null ? "—" : fmt(record.si, 3)}</td>
          <td>${record.landscape ? escapeHtml(modeLabel(record.landscape)) : "—"}</td>
          <td>${escapeHtml(modeLabel(record.recommended))}</td>
          <td>${flagBadges(recordFlags(cell, key))}</td>
        </tr>`;
      }).join("");
      els.cellScenarioCompare.innerHTML = tableWrap(
        `<table class="data-table"><thead><tr><th>Сценарий</th><th>Нормативный статус</th><th>SI</th><th>Класс</th><th>Режим</th><th>Флаги</th></tr></thead><tbody>${rows}</tbody></table>`
      );
    }

    const cross = DATA.experiment.cross_scenario;
    els.conflictSummary.innerHTML = `
      <div class="metric-grid">
        <div class="metric-card"><span class="metric-label">Ячеек с расхождением режимов</span><span class="metric-value">${fmtInt(cross.conflict_count)}</span></div>
        <div class="metric-card"><span class="metric-label">Развитие против запрета/проверки</span><span class="metric-value">${fmtInt(cross.development_conflict_count)}</span></div>
        <div class="metric-card"><span class="metric-label">Сохранение против развития</span><span class="metric-value">${fmtInt(cross.preservation_vs_development_count)}</span></div>
        <div class="metric-card"><span class="metric-label">Ячеек в топ-10 всех сценариев</span><span class="metric-value">${fmtInt(cross.top10_all_count)}</span></div>
      </div>`;

    const conflictRows = cross.conflict_examples
      .map((item) => {
        const modes = SCENARIO_KEYS.map(
          (key) => `<span class="small-text">${escapeHtml(SCENARIO_BY_KEY[key].short_label)}: ${escapeHtml(modeLabel(item.modes[key] || "—"))}</span>`
        ).join("<br>");
        return `<tr class="is-clickable" data-select-cell="${item.cell_id}">
          <td class="nowrap">${escapeHtml(item.cell_id)}</td>
          <td>${item.row}/${item.column}</td>
          <td>${modes}</td>
          <td class="num">${item.distinct_count}</td>
        </tr>`;
      })
      .join("");
    els.conflictExamples.innerHTML = tableWrap(
      `<table class="data-table"><thead><tr><th>Ячейка</th><th>Стр/стлб</th><th>Режимы по сценариям</th><th>Различий</th></tr></thead><tbody>${conflictRows}</tbody></table>`
    );
  };

  const runSearch = () => {
    const boundaryFilter = els.searchBoundary.value;
    const minInside = Number(els.searchInside.value) / 100;
    const maxSiRaw = els.searchMaxSi.value.trim();
    const maxSi = maxSiRaw === "" ? null : Number(maxSiRaw);
    const counts = {
      prohibited: 0,
      review: 0,
      notAssessed: 0,
      missing: 0,
      filtered: 0,
    };
    const results = [];

    for (const cell of CELLS) {
      const record = decode(cell, state.scenario);
      if (record.effectiveNorm === "prohibited") {
        counts.prohibited += 1;
        continue;
      }
      if (record.effectiveNorm === "unclassified") {
        counts.review += 1;
        continue;
      }
      if (record.effectiveNorm === "not_assessed") {
        counts.notAssessed += 1;
        continue;
      }
      if (record.status !== "calculated" || record.si === null) {
        counts.missing += 1;
        continue;
      }
      if (boundaryFilter === "interior" && cell.b) {
        counts.filtered += 1;
        continue;
      }
      if (boundaryFilter === "boundary" && !cell.b) {
        counts.filtered += 1;
        continue;
      }
      if (cell.in < minInside) {
        counts.filtered += 1;
        continue;
      }
      if (maxSi !== null && !Number.isNaN(maxSi) && record.si > maxSi) {
        counts.filtered += 1;
        continue;
      }
      results.push({
        cell,
        record,
        flags: recordFlags(cell, state.scenario),
      });
    }

    results.sort((left, right) => {
      if (left.record.si !== right.record.si) return left.record.si - right.record.si;
      if (left.cell.in !== right.cell.in) return right.cell.in - left.cell.in;
      if (left.cell.r !== right.cell.r) return left.cell.r - right.cell.r;
      return left.cell.c - right.cell.c;
    });

    // Индекс в подготовленных данных сохранён с точностью до 6 знаков.
    const minimum = results.length ? results[0].record.si : null;
    state.searchResults = minimum === null ? [] : results.filter((item) => item.record.si === minimum);
    state.searchStats = { total: results.length, counts };
    renderSearchResults();
    updateMapHighlights();
  };

  const renderSearchResults = () => {
    const stats = state.searchStats || { total: 0, counts: {} };
    const counts = stats.counts || {};
    els.searchCount.textContent = fmtInt(stats.total);
    els.searchSummary.innerHTML = [
      ["Проверено ячеек", CELLS.length],
      ["Доступно для сравнения", stats.total],
      ["Ячеек с минимумом", state.searchResults.length],
      ["Исключено: запрет", counts.prohibited || 0],
      ["Исключено: R2", counts.review || 0],
      ["Исключено: нет данных", (counts.missing || 0) + (counts.notAssessed || 0)],
      ["Не прошли фильтры", counts.filtered || 0],
    ]
      .map(
        ([label, value]) =>
          `<span class="summary-chip">${escapeHtml(label)}: <strong>${fmtInt(value)}</strong></span>`
      )
      .join("");

    if (!state.searchResults.length) {
      els.searchResults.innerHTML =
        '<div class="empty-state">Нет ячеек, удовлетворяющих условиям. Ослабьте фильтры.</div>';
      return;
    }

    const rows = state.searchResults.map((item, index) => {
      const record = item.record;
      return `<tr class="is-clickable ${index < 3 ? "is-top" : ""}" data-select-cell="${item.cell.id}">
        <td class="num">${index + 1}</td>
        <td class="nowrap">${escapeHtml(item.cell.id)}</td>
        <td class="num">${fmt(record.si, 4)}</td>
        <td>${record.landscape ? escapeHtml(modeLabel(record.landscape)) : "—"}</td>
        <td>${escapeHtml(modeLabel(record.recommended))}</td>
        <td>${escapeHtml(normLabel(record.effectiveNorm))}</td>
        <td class="num">${fmtPercent(item.cell.in)}</td>
        <td>${flagBadges(item.flags)}</td>
      </tr>`;
    }).join("");
    const incomplete = (counts.review || 0) + (counts.missing || 0) + (counts.notAssessed || 0);
    const scope = incomplete || counts.filtered ? `<p class="notice notice-warning">Поиск выполнен среди доступных ячеек, прошедших фильтры. Из-за пропусков, неопределённости или фильтров нельзя утверждать, что минимум найден среди всех ячеек территории.</p>` : "";
    els.searchResults.innerHTML = scope + tableWrap(
      `<table class="data-table"><thead><tr><th>#</th><th>Ячейка</th><th>SI</th><th>Класс</th><th>Режим</th><th>Статус</th><th>Внутри</th><th>Флаги</th></tr></thead><tbody>${rows}</tbody></table>`
    );
  };

  const renderExperiment = () => {
    const experiment = DATA.experiment;
    const scenarioExperiment = experiment.scenarios[state.scenario];
    if (!scenarioExperiment) return;
    const counts = scenarioExperiment.counts;
    els.experimentScenarioLabel.textContent = currentScenario().label;

    els.experimentDefinitions.innerHTML = Object.entries(experiment.definitions)
      .map(
        ([key, text]) =>
          `<div class="definition-card"><strong>${escapeHtml(key)}</strong><p>${escapeHtml(text)}</p></div>`
      )
      .join("");

    const metric = (label, value, note = "") =>
      `<div class="metric-card"><span class="metric-label">${escapeHtml(label)}</span><span class="metric-value">${fmtInt(value)}</span>${note ? `<span class="metric-note">${escapeHtml(note)}</span>` : ""}</div>`;
    els.experimentCounts.innerHTML = [
      metric("Всего ячеек", counts.total),
      metric("Полный набор критериев", counts.complete_criteria),
      metric("Рассчитано", counts.calculated),
      metric("Запрет R3", counts.prohibited),
      metric("Проверка R2", counts.review),
      metric("Нет критериев", counts.missing_criteria),
    ].join("");

    const comparisonRows = ["A", "B", "C"]
      .map((key) => {
        const item = scenarioExperiment[key];
        const top = item.top[0];
        return `<tr class="${state.experimentView === key ? "is-selected" : ""}">
          <td><strong>${key}</strong></td>
          <td class="num">${fmtInt(item.candidate_count)}</td>
          <td class="nowrap">${top ? escapeHtml(top.cell_id) : "—"}</td>
          <td class="num">${top ? fmt(top.si, 4) : "—"}</td>
          <td class="num">${fmtInt(item.prohibited_in_top || 0)}</td>
          <td class="num">${fmtInt(item.review_in_top || 0)}</td>
          <td class="num">${fmtInt(item.excluded_prohibited || 0)}</td>
          <td class="num">${fmtInt(item.excluded_review || 0)}</td>
        </tr>`;
      })
      .join("");
    els.experimentComparison.innerHTML = tableWrap(
      `<table class="data-table"><thead><tr><th>Вариант</th><th>Кандидатов</th><th>Топ-1</th><th>SI топ-1</th><th>R3 в топ-10</th><th>R2 в топ-10</th><th>Искл. R3</th><th>Искл. R2</th></tr></thead><tbody>${comparisonRows}</tbody></table>`
    );

    const experimentItem = scenarioExperiment[state.experimentView];
    const topRows = experimentItem.top
      .map(
        (item, index) => `<tr class="is-clickable ${index < 3 ? "is-top" : ""}" data-select-cell="${item.cell_id}">
          <td class="num">${index + 1}</td>
          <td class="nowrap">${escapeHtml(item.cell_id)}</td>
          <td class="num">${fmt(item.si, 4)}</td>
          <td>${item.landscape ? escapeHtml(modeLabel(item.landscape)) : "—"}</td>
          <td>${escapeHtml(modeLabel(item.recommended))}</td>
          <td>${flagBadges(item.flags)}</td>
          <td>${item.source === "diagnostic" ? "диагностический" : "официальный"}</td>
        </tr>`
      )
      .join("");
    els.experimentTop.innerHTML = tableWrap(
      `<table class="data-table"><thead><tr><th>#</th><th>Ячейка</th><th>SI</th><th>Класс</th><th>Режим</th><th>Флаги</th><th>Индекс</th></tr></thead><tbody>${topRows}</tbody></table>`
    );
    els.experimentTopNote.textContent =
      state.experimentView === "C"
        ? "C — рабочий рейтинг: только рассчитанные ячейки с допустимым или условным статусом."
        : "A и B могут включать диагностический индекс для ячеек, где официальный расчёт не выполнялся. Это эксперимент, а не результат метода.";

    els.experimentReviewCount.textContent = fmtInt(scenarioExperiment.C.flagged_review_total || 0);
    if (!scenarioExperiment.C.flagged_review.length) {
      els.experimentReview.innerHTML =
        '<div class="empty-state">Нет ячеек R2 с доступными физическими критериями.</div>';
    } else {
      const rows = scenarioExperiment.C.flagged_review
        .map(
          (item) => `<tr class="is-clickable" data-select-cell="${item.cell_id}">
            <td class="nowrap">${escapeHtml(item.cell_id)}</td>
            <td>${item.row}/${item.column}</td>
            <td>${escapeHtml(normLabel(item.effective_norm))}</td>
            <td class="num">${item.si === null ? "—" : fmt(item.si, 4)}</td>
            <td>${item.si === null ? "физические критерии не рассчитаны ни в одном сценарии" : "диагностический индекс доступен"}</td>
          </tr>`
        )
        .join("");
      els.experimentReview.innerHTML = tableWrap(
        `<table class="data-table"><thead><tr><th>Ячейка</th><th>Стр/стлб</th><th>Статус</th><th>Диагн. SI</th><th>Комментарий</th></tr></thead><tbody>${rows}</tbody></table>`
      );
    }

    const cross = experiment.cross_scenario;
    els.experimentCross.innerHTML = [
      metric("Расхождений режимов", cross.conflict_count),
      metric("Развитие против запрета/проверки", cross.development_conflict_count),
      metric("Сохранение против развития", cross.preservation_vs_development_count),
      metric("В топ-10 всех сценариев", cross.top10_all_count),
      metric("Уникальных в одном топ-10", cross.top10_unique_count),
    ].join("");

    const overlapRows = SCENARIO_KEYS.map((rowKey) => {
      const cells = SCENARIO_KEYS.map((colKey) => {
        const value = cross.top10_overlap_jaccard[rowKey][colKey];
        return `<td class="num">${fmt(value, 2)}</td>`;
      }).join("");
      return `<tr><td>${escapeHtml(SCENARIO_BY_KEY[rowKey].short_label)}</td>${cells}</tr>`;
    }).join("");
    els.experimentOverlap.innerHTML = tableWrap(
      `<table class="data-table"><thead><tr><th>Сценарий</th>${SCENARIO_KEYS.map((key) => `<th>${escapeHtml(SCENARIO_BY_KEY[key].short_label)}</th>`).join("")}</tr></thead><tbody>${overlapRows}</tbody></table>`
    );

    const conflictRows = cross.conflict_examples
      .map((item) => {
        const modes = SCENARIO_KEYS.map(
          (key) =>
            `<span class="small-text">${escapeHtml(SCENARIO_BY_KEY[key].short_label)}: ${escapeHtml(modeLabel(item.modes[key] || "—"))}</span>`
        ).join("<br>");
        return `<tr class="is-clickable" data-select-cell="${item.cell_id}">
          <td class="nowrap">${escapeHtml(item.cell_id)}</td>
          <td>${modes}</td>
        </tr>`;
      })
      .join("");
    els.experimentConflicts.innerHTML = tableWrap(
      `<table class="data-table"><thead><tr><th>Ячейка</th><th>Режимы</th></tr></thead><tbody>${conflictRows}</tbody></table>`
    );

    renderExperimentReport(scenarioExperiment, cross);
  };

  const renderExperimentReport = (scenarioExperiment, cross) => {
    const a = scenarioExperiment.A;
    const b = scenarioExperiment.B;
    const c = scenarioExperiment.C;
    const topA = a.top[0];
    const topB = b.top[0];
    const topC = c.top[0];
    const sameTop =
      topA &&
      topB &&
      topC &&
      topA.cell_id === topB.cell_id &&
      topB.cell_id === topC.cell_id;
    const reviewWithoutDiagnostics = c.flagged_review_total - c.flagged_review_with_diagnostics;
    const minOverlap = Math.min(
      ...SCENARIO_KEYS.map((rowKey) =>
        Math.min(
          ...SCENARIO_KEYS.filter((colKey) => colKey !== rowKey).map(
            (colKey) => cross.top10_overlap_jaccard[rowKey][colKey]
          )
        )
      )
    );
    const maxOverlap = Math.max(
      ...SCENARIO_KEYS.map((rowKey) =>
        Math.max(
          ...SCENARIO_KEYS.filter((colKey) => colKey !== rowKey).map(
            (colKey) => cross.top10_overlap_jaccard[rowKey][colKey]
          )
        )
      )
    );

    const answers = [
      {
        question: "Что изменилось при исключении R3?",
        answer: `Число кандидатов уменьшилось с ${fmtInt(a.candidate_count)} до ${fmtInt(b.candidate_count)}. В топ-10 варианта A было ${fmtInt(a.prohibited_in_top)} запрещённых ячеек, в варианте B — ${fmtInt(b.prohibited_in_top)}. ${sameTop ? "Первая ячейка рейтинга не изменилась." : "Первая ячейка рейтинга изменилась."}`,
      },
      {
        question: "Сколько ячеек R2 и почему они не ранжируются?",
        answer: `В сценарии ${fmtInt(c.excluded_review)} ячеек R2. Диагностический индекс доступен для ${fmtInt(c.flagged_review_with_diagnostics)} из них; у ${fmtInt(reviewWithoutDiagnostics)} физические критерии не рассчитаны ни в одном сценарии. Поэтому R2 показаны как флаги и не входят в рейтинг.`,
      },
      {
        question: "Совпадают ли топ-10 сценариев?",
        answer: `В топ-10 всех четырёх сценариев входят ${fmtInt(cross.top10_all_count)} ячеек; ${fmtInt(cross.top10_unique_count)} ячеек уникальны для одного сценария. Минимальное парное пересечение топ-10 — ${fmt(minOverlap, 2)}, максимальное — ${fmt(maxOverlap, 2)} по Жаккару.`,
      },
      {
        question: "Где возникают конфликты режимов?",
        answer: `Расхождения режимов есть в ${fmtInt(cross.conflict_count)} ячейках. Из них ${fmtInt(cross.development_conflict_count)} — развитие против запрета или проверки, ${fmtInt(cross.preservation_vs_development_count)} — сохранение против развития.`,
      },
      {
        question: "Какие выводы допустимы?",
        answer: "Допустимы выводы о технической воспроизводимости, влиянии нормативного фильтра на состав кандидатов и различии сценариев. Недопустимы выводы о научной обоснованности весов, юридической допустимости или готовности территории к освоению: параметры демонстрационные.",
      },
    ];

    els.experimentReport.innerHTML = `<ol>${answers
      .map(
        (item) =>
          `<li><strong>${escapeHtml(item.question)}</strong><span class="answer">${escapeHtml(item.answer)}</span></li>`
      )
      .join("")}</ol>
      <p class="field-hint">Шаблон отчёта: вопрос → наблюдение → ограничение → вывод. Числа пересчитываются из сохранённых данных при каждом запуске.</p>`;
  };

  const renderMethod = () => {
    const criteriaRows = CRITERIA.map((criterion) => {
      const direction =
        criterion.direction === "scenario"
          ? "зависит от сценария"
          : criterion.direction === "direct"
            ? "прямая"
            : "обратная";
      return `<tr>
        <td><strong>${escapeHtml(criterion.label)}</strong><br><span class="small-text">${escapeHtml(criterion.description)}</span></td>
        <td>${escapeHtml(criterion.unit)}</td>
        <td class="num">${fmt(criterion.lower, 2)}–${fmt(criterion.upper, 2)}</td>
        <td>${direction}</td>
        <td>${escapeHtml(criterion.direction_label)}</td>
      </tr>`;
    }).join("");
    els.criteriaTable.innerHTML = tableWrap(
      `<table class="data-table"><thead><tr><th>Критерий</th><th>Ед.</th><th>Границы</th><th>Направление</th><th>Пояснение</th></tr></thead><tbody>${criteriaRows}</tbody></table>`
    );

    const weightRows = SCENARIOS.map((scenario) => {
      const weights = scenario.weights.map((value) => `<td class="num">${fmt(value, 3)}</td>`).join("");
      return `<tr><td>${escapeHtml(scenario.label)}</td>${weights}<td class="num">${fmt(scenario.weight_sum, 3)}</td><td>${scenario.development_direction === "inverse" ? "обратная" : "прямая"}</td></tr>`;
    }).join("");
    els.weightsTable.innerHTML = tableWrap(
      `<table class="data-table"><thead><tr><th>Сценарий</th>${CRITERIA.map((criterion) => `<th>${escapeHtml(criterion.short_label)}</th>`).join("")}<th>Сумма</th><th>Направление K4</th></tr></thead><tbody>${weightRows}</tbody></table>`
    );

    const normRows = NORM_ORDER.map((name) => {
      const status = META.norm_statuses[name];
      return `<tr><td>${swatch(status.color)} ${escapeHtml(status.label)}</td><td>${escapeHtml(status.description)}</td></tr>`;
    }).join("");
    els.normStatusTable.innerHTML = `<h4>Нормативные статусы</h4>${tableWrap(
      `<table class="data-table"><thead><tr><th>Статус</th><th>Смысл</th></tr></thead><tbody>${normRows}</tbody></table>`
    )}`;

    const modeRows = MODE_ORDER.map((name) => {
      const mode = META.modes[name];
      return `<tr><td>${swatch(mode.color)} ${escapeHtml(mode.label)}</td><td>${escapeHtml(mode.description)}</td></tr>`;
    }).join("");
    els.modeTable.innerHTML = `<h4>Режимы</h4>${tableWrap(
      `<table class="data-table"><thead><tr><th>Режим</th><th>Смысл</th></tr></thead><tbody>${modeRows}</tbody></table>`
    )}`;

    if (DATA.synthetic_check) {
      const rows = DATA.synthetic_check.rows;
      const inputRows = rows
        .map(
          (row) => `<tr><td><strong>${escapeHtml(row.cell)}</strong></td><td class="num">${row.x}</td><td class="num">${row.y}</td><td class="num">${fmt(row.k[0], 1)}</td><td class="num">${fmt(row.k[1], 1)}</td><td class="num">${fmt(row.k[2], 2)}</td><td class="num">${fmt(row.k[3], 0)}</td><td class="num">${row.norm}</td><td>${escapeHtml(row.norm_reason || "")}</td></tr>`
        )
        .join("");
      const outputRows = SCENARIO_KEYS.map((key) => {
        const cells = rows
          .map((row) => {
            const item = row.scenarios[key];
            return `<td><span class="nowrap">${fmt(item.si, 3)}</span><br><span class="small-text">${escapeHtml(item.final)}</span></td>`;
          })
          .join("");
        return `<tr><td>${escapeHtml(scenarioLabel(key))}</td>${cells}</tr>`;
      }).join("");
      els.syntheticCheck.innerHTML = `
        ${tableWrap(`<table class="data-table"><thead><tr><th>Ячейка</th><th>X</th><th>Y</th><th>K1</th><th>K2</th><th>K3</th><th>K4</th><th>R</th><th>Основание R</th></tr></thead><tbody>${inputRows}</tbody></table>`)}
        <div style="height:12px"></div>
        ${tableWrap(`<table class="data-table"><thead><tr><th>Сценарий</th>${rows.map((row) => `<th>${escapeHtml(row.cell)}</th>`).join("")}</tr></thead><tbody>${outputRows}</tbody></table>`)}
        <div class="notice notice-warning">Для ячейки D (R3) сохранённый индекс показан как диагностический. В карточке и рейтинге для R3 индекс скрыт, чтобы запрет не компенсировался низкой чувствительностью.</div>`;
    } else {
      els.syntheticCheck.innerHTML =
        '<div class="empty-state">Синтетический пример не найден.</div>';
    }

    const sourceRows = META.data_sources
      .map(
        (source) => `<tr><td><strong>${escapeHtml(source.name)}</strong></td><td>${escapeHtml(source.source)}</td><td>${escapeHtml(source.date)}</td><td>${escapeHtml(source.license)}</td><td>${escapeHtml(source.details)}</td></tr>`
      )
      .join("");
    els.sourcesTable.innerHTML = tableWrap(
      `<table class="data-table"><thead><tr><th>Данные</th><th>Источник</th><th>Дата</th><th>Лицензия</th><th>Примечание</th></tr></thead><tbody>${sourceRows}</tbody></table>`
    );

    els.limitationsList.innerHTML = `<ul class="small-text">${META.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
    els.contradictionsList.innerHTML = `<h4>Зафиксированные расхождения</h4><div class="grid-two">${META.contradictions
      .map(
        (item) =>
          `<div class="notice notice-info"><strong>${escapeHtml(item.title)}</strong><br>${escapeHtml(item.text)}</div>`
      )
      .join("")}</div>`;
  };

  const renderData = () => {
    const grid = META.grid;
    const normativeReport = META.data_quality?.normative_report || {};
    const zoneCount =
      normativeReport.input_zone_count ?? Object.keys(META.zone_sources).length;
    const rows = [
      ["Территория", META.territory],
      ["Система координат", `${META.crs} · ${META.crs_name}`],
      ["Сетка", `${grid.columns} × ${grid.rows} ячеек по ${fmt(grid.cell_size_m, 0)} м`],
      ["Сохранено ячеек", fmtInt(grid.cell_count)],
      ["Граничных ячеек", fmtInt(grid.boundary_cell_count)],
      ["Площадь территории", `${fmt(grid.territory_area_km2, 3)} км²`],
      ["Статус параметров", META.parameter_status_label],
      ["Дата подготовки", META.generated_at],
      ["Сценариев", String(META.scenarios.length)],
      ["Нормативных зон", fmtInt(zoneCount)],
      ["Ключей зон по сценариям", fmtInt(Object.keys(META.zone_sources).length)],
    ];
    els.datasetInfo.innerHTML = rows
      .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`)
      .join("");

    const sourceRows = META.data_sources
      .map(
        (source) => `<tr><td><strong>${escapeHtml(source.name)}</strong></td><td>${escapeHtml(source.source)}</td><td>${escapeHtml(source.date)}</td><td>${escapeHtml(source.license)}</td><td>${escapeHtml(source.details)}</td></tr>`
      )
      .join("");
    els.dataSourcesTable.innerHTML = tableWrap(
      `<table class="data-table"><thead><tr><th>Данные</th><th>Источник</th><th>Дата</th><th>Лицензия</th><th>Примечание</th></tr></thead><tbody>${sourceRows}</tbody></table>`
    );
  };

  const setScenario = (key) => {
    if (!SCENARIO_BY_KEY[key] || key === state.scenario) return;
    state.scenario = key;
    renderScenarioSwitch();
    renderSearchScenarioSelect();
    renderMap();
    renderCellPanel();
    renderCompare();
    runSearch();
    renderExperiment();
    updateURL();
  };

  const setView = (view, { scroll = true } = {}) => {
    const target = document.getElementById(`view-${view}`);
    if (!target) return;
    state.view = view;
    document.querySelectorAll(".view").forEach((section) => {
      section.classList.toggle("is-active", section.id === `view-${view}`);
    });
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.toggle("is-active", tab.dataset.view === view);
    });
    if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
    if (view === "map") {
      window.requestAnimationFrame(() => {
        applyView();
        updateMapHighlights();
      });
    }
    updateURL();
  };

  const updateURL = () => {
    const params = new URLSearchParams();
    params.set("scenario", state.scenario);
    if (state.view !== "map") params.set("view", state.view);
    if (state.layer !== "recommended") params.set("layer", state.layer);
    if (state.layer === "raw" && state.rawCriterion !== "slope") {
      params.set("criterion", state.rawCriterion);
    }
    if (state.selectedId) params.set("cell", state.selectedId);
    if (state.compare.size) params.set("compare", Array.from(state.compare).join(","));
    const query = params.toString();
    const url = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
    try {
      window.history.replaceState(null, "", url);
    } catch {}
  };

  const readURL = () => {
    const params = new URLSearchParams(window.location.search);
    const scenario = params.get("scenario");
    if (scenario && SCENARIO_BY_KEY[scenario]) state.scenario = scenario;
    const view = params.get("view");
    if (["map", "compare", "search", "experiment", "method", "data"].includes(view)) {
      state.view = view;
    }
    const layer = params.get("layer");
    if (["recommended", "norm", "landscape", "raw", "conflict"].includes(layer)) {
      state.layer = layer;
    }
    const criterion = params.get("criterion");
    if (criterion && criterion in CRITERION_INDEX) state.rawCriterion = criterion;
    const cell = params.get("cell");
    if (cell && BY_ID.has(cell)) state.selectedId = cell;
    const compare = params.get("compare");
    if (compare) {
      for (const id of compare.split(",").slice(0, 8)) {
        if (BY_ID.has(id)) state.compare.add(id);
      }
    }
  };

  const downloadCSV = (filename, rows) => {
    const escapeCell = (value) => {
      const text = String(value ?? "");
      return /[",\n;]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const csv = rows.map((row) => row.map(escapeCell).join(";")).join("\n");
    const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  };

  const exportCompare = () => {
    const selected = Array.from(state.compare)
      .map((id) => BY_ID.get(id))
      .filter(Boolean);
    if (!selected.length) {
      showToast("Сначала добавьте ячейки к сравнению.");
      return;
    }
    const rows = [
      [
        "cell_id",
        "row",
        "column",
        "scenario",
        "effective_norm_status",
        "sensitivity_index",
        "landscape_mode",
        "recommended_mode",
        "inside_share",
        "K1_slope_deg",
        "K2_hydro_m",
        "K3_natural_share",
        "K4_development_m",
      ],
    ];
    for (const cell of selected) {
      const record = scenarioRecord(cell);
      rows.push([
        cell.id,
        cell.r,
        cell.c,
        scenarioLabel(state.scenario),
        normLabel(record.effectiveNorm),
        record.si === null ? "" : record.si,
        record.landscape ? modeLabel(record.landscape) : "",
        modeLabel(record.recommended),
        cell.in,
        cell.k[0] ?? "",
        cell.k[1] ?? "",
        cell.k[2] ?? "",
        cell.k[3] ?? "",
      ]);
    }
    downloadCSV("compare_cells.csv", rows);
  };

  const exportSearch = () => {
    if (!state.searchResults.length) {
      showToast("Нет результатов для экспорта.");
      return;
    }
    const rows = [
      [
        "rank",
        "cell_id",
        "row",
        "column",
        "sensitivity_index",
        "landscape_mode",
        "recommended_mode",
        "effective_norm_status",
        "inside_share",
        "boundary",
        "flags",
      ],
    ];
    state.searchResults.forEach((item, index) => {
      rows.push([
        index + 1,
        item.cell.id,
        item.cell.r,
        item.cell.c,
        item.record.si,
        item.record.landscape ? modeLabel(item.record.landscape) : "",
        modeLabel(item.record.recommended),
        normLabel(item.record.effectiveNorm),
        item.cell.in,
        item.cell.b ? 1 : 0,
        item.flags.join("|"),
      ]);
    });
    downloadCSV("search_minimum.csv", rows);
  };

  const bindEvents = () => {
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => setView(tab.dataset.view));
    });
    document.querySelectorAll("[data-view-link]").forEach((button) => {
      button.addEventListener("click", () => setView(button.dataset.viewLink));
    });

    els.layerSwitch.addEventListener("change", (event) => {
      if (event.target.name !== "layer") return;
      state.layer = event.target.value;
      els.rawCriterionField.hidden = state.layer !== "raw";
      renderMap();
      updateURL();
    });
    els.rawCriterion.addEventListener("change", () => {
      state.rawCriterion = els.rawCriterion.value;
      if (state.layer === "raw") renderMap();
      updateURL();
    });
    els.dimUncalculated.addEventListener("change", () => {
      state.dimUncalculated = els.dimUncalculated.checked;
      updateMapHighlights();
    });

    document.getElementById("zoomIn").addEventListener("click", () => zoomView(1.5));
    document.getElementById("zoomOut").addEventListener("click", () => zoomView(1 / 1.5));
    document.getElementById("resetView").addEventListener("click", resetView);
    document.getElementById("copyViewLink").addEventListener("click", () => copyText(window.location.href));

    document.getElementById("cellLookupButton").addEventListener("click", () => {
      const id = els.cellLookup.value.trim();
      if (BY_ID.has(id)) {
        els.cellLookupHint.textContent = "";
        selectCell(id, { switchView: true, focus: true });
      } else {
        els.cellLookupHint.textContent =
          "Ячейка не найдена. Пример ID: r000084_c000052.";
      }
    });
    els.cellLookup.addEventListener("keydown", (event) => {
      if (event.key === "Enter") document.getElementById("cellLookupButton").click();
    });

    els.cellPanel.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      const action = button.dataset.action;
      if (action === "add-compare") addCompare(state.selectedId);
      if (action === "remove-compare") removeCompare(state.selectedId);
      if (action === "copy-cell-link") copyText(window.location.href);
    });

    document.getElementById("clearCompare").addEventListener("click", () => {
      state.compare.clear();
      renderCompare();
      updateMapHighlights();
      updateURL();
    });
    document.getElementById("exportCompare").addEventListener("click", exportCompare);
    document.getElementById("exportSearch").addEventListener("click", exportSearch);
    document.getElementById("showConflictsOnMap").addEventListener("click", () => {
      state.layer = "conflict";
      document.querySelector('input[name="layer"][value="conflict"]').checked = true;
      els.rawCriterionField.hidden = true;
      setView("map");
      renderMap();
      updateURL();
    });
    document.getElementById("experimentShowConflicts").addEventListener("click", () => {
      state.layer = "conflict";
      document.querySelector('input[name="layer"][value="conflict"]').checked = true;
      els.rawCriterionField.hidden = true;
      setView("map");
      renderMap();
      updateURL();
    });

    els.searchScenario.addEventListener("change", () => setScenario(els.searchScenario.value));
    els.searchInside.addEventListener("input", () => {
      els.searchInsideValue.textContent = `${els.searchInside.value}%`;
    });
    document.getElementById("runSearch").addEventListener("click", runSearch);
    els.searchBoundary.addEventListener("change", runSearch);
    els.searchMaxSi.addEventListener("change", runSearch);

    document.getElementById("experimentSwitch").addEventListener("click", (event) => {
      const button = event.target.closest("[data-experiment]");
      if (!button) return;
      state.experimentView = button.dataset.experiment;
      document.querySelectorAll("#experimentSwitch button").forEach((item) => {
        item.classList.toggle("is-active", item.dataset.experiment === state.experimentView);
      });
      renderExperiment();
    });

    document.querySelectorAll("[data-select-cell]").forEach(() => {});
    document.addEventListener("click", (event) => {
      const row = event.target.closest("[data-select-cell]");
      if (!row) return;
      const id = row.dataset.selectCell;
      const targetScenario = row.dataset.scenarioTarget;
      if (targetScenario && SCENARIO_BY_KEY[targetScenario]) {
        setScenario(targetScenario);
      }
      selectCell(id, { switchView: true, focus: true });
    });

    bindMapEvents();
    window.addEventListener("popstate", () => {
      readURL();
      renderScenarioSwitch();
      renderSearchScenarioSelect();
      renderMap();
      renderCellPanel();
      renderCompare();
      runSearch();
      renderExperiment();
      setView(state.view, { scroll: false });
    });
    window.addEventListener("resize", () => {
      applyView();
    });
  };

  const bindMapEvents = () => {
    const svg = els.map;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startView = null;
    let moved = false;

    svg.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      dragging = true;
      moved = false;
      startX = event.clientX;
      startY = event.clientY;
      startView = state.mapView ? { ...state.mapView } : fullView();
      svg.classList.add("is-dragging");
    });

    svg.addEventListener("pointermove", (event) => {
      const target = event.target.closest?.(".cell");
      if (target) {
        const cell = BY_ID.get(target.dataset.id);
        if (cell) {
          const record = scenarioRecord(cell);
          const tooltipRows = [
            `<strong>${escapeHtml(cell.id)}</strong>`,
            `${escapeHtml(scenarioLabel(state.scenario))}`,
            `${escapeHtml(modeLabel(record.recommended))}`,
          ];
          if (record.status === "calculated") {
            tooltipRows.push(`SI: ${fmt(record.si, 3)} · ${escapeHtml(modeLabel(record.landscape))}`);
          } else {
            tooltipRows.push(escapeHtml(normLabel(record.effectiveNorm)));
          }
          els.mapTooltip.innerHTML = tooltipRows.join("<br>");
          els.mapTooltip.hidden = false;
          const rect = els.mapCanvas.getBoundingClientRect();
          const left = Math.min(rect.width - 240, Math.max(8, event.clientX - rect.left + 12));
          const top = Math.min(rect.height - 90, Math.max(8, event.clientY - rect.top + 12));
          els.mapTooltip.style.left = `${left}px`;
          els.mapTooltip.style.top = `${top}px`;
        }
      } else {
        els.mapTooltip.hidden = true;
      }

      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      if (!svg.hasPointerCapture(event.pointerId)) svg.setPointerCapture(event.pointerId);
      const pixelWidth = svg.getBoundingClientRect().width || 800;
      const unitsPerPixel = startView.w / pixelWidth;
      state.mapView = clampView({
        x: startView.x - dx * unitsPerPixel,
        y: startView.y - dy * unitsPerPixel,
        w: startView.w,
        h: startView.h,
      });
      applyView();
    });

    const endDrag = (event) => {
      if (!dragging) return;
      dragging = false;
      svg.classList.remove("is-dragging");
      if (svg.hasPointerCapture?.(event.pointerId)) {
        svg.releasePointerCapture(event.pointerId);
      }
      state.suppressClick = moved;
    };
    svg.addEventListener("pointerup", endDrag);
    svg.addEventListener("pointercancel", endDrag);

    svg.addEventListener("click", (event) => {
      if (state.suppressClick) {
        state.suppressClick = false;
        return;
      }
      const target = event.target.closest?.(".cell");
      if (!target) return;
      const id = target.dataset.id;
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        addCompare(id);
      } else {
        selectCell(id);
      }
    });

    svg.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const view = state.mapView || fullView();
      const cx = view.x + ((event.clientX - rect.left) / rect.width) * view.w;
      const cy = view.y + ((event.clientY - rect.top) / rect.height) * view.h;
      zoomView(event.deltaY < 0 ? 1.18 : 1 / 1.18, cx, cy);
    }, { passive: false });

    svg.addEventListener("pointerleave", () => {
      els.mapTooltip.hidden = true;
    });
  };

  const syncControls = () => {
    document.querySelectorAll('input[name="layer"]').forEach((input) => {
      input.checked = input.value === state.layer;
    });
    els.rawCriterionField.hidden = state.layer !== "raw";
    els.rawCriterion.value = state.rawCriterion;
    els.dimUncalculated.checked = state.dimUncalculated;
    els.searchInside.value = "0";
    els.searchInsideValue.textContent = "0%";
    els.searchScenario.value = state.scenario;
    document.querySelectorAll("#experimentSwitch button").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.experiment === state.experimentView);
    });
  };

  const init = () => {
    readURL();
    syncControls();
    renderScenarioSwitch();
    renderSearchScenarioSelect();
    renderMap();
    renderCellPanel();
    renderCompare();
    runSearch();
    renderExperiment();
    renderMethod();
    renderData();
    bindEvents();
    setView(state.view, { scroll: false });
    if (state.selectedId) {
      selectCell(state.selectedId);
    }
  };

  init();
})();
