/* Weather PWS Viewer - app.js */
(function () {
  'use strict';

  // --- State ---
  let stations = [];
  let currentStation = null;
  let currentObs = null;
  let historyData = null;
  // F13: safe localStorage access
  let selectedRange = lsGet('weatherRange') || '24h';
  let customEndDate = null;
  let customRange = null;
  let pollTimer = null;
  let pollInterval = parseInt(lsGet('weatherInterval') || '60', 10);
  let fontScale = parseFloat(lsGet('weatherFontScale') || '1') || 1;

  // Chart instances
  const charts = {};

  // --- F13: localStorage helpers ---
  function lsGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, val); } catch { /* Safari private mode */ }
  }

  // --- Helpers ---
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function fmt(v, dec) {
    if (v == null) return '--';
    return typeof v === 'number' ? v.toFixed(dec ?? 1) : String(v);
  }

  function fmtTime(isoStr) {
    if (!isoStr) return '--';
    try {
      const d = new Date(isoStr);
      return d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });
    } catch { return isoStr; }
  }

  function fmtTimeShort(isoStr) {
    if (!isoStr) return '--';
    try {
      const d = new Date(isoStr);
      return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });
    } catch { return isoStr; }
  }

  function windDirName(deg) {
    if (deg == null) return '--';
    const dirJa = ['北','北北東','北東','東北東','東','東南東','南東','南南東','南','南南西','南西','西南西','西','西北西','北西','北北西'];
    const idx = Math.round(deg / 22.5) % 16;
    return dirJa[idx];
  }

  // F8: windDir sanitized before SVG generation
  function windArrowSvg(deg) {
    if (deg == null) return '';
    const n = Number(deg);
    if (!isFinite(n)) return '';
    return `<svg viewBox="0 0 24 24" fill="none" stroke="#4da6ff" stroke-width="2" stroke-linecap="round"><g transform="rotate(${n},12,12)"><line x1="12" y1="4" x2="12" y2="20"/><polyline points="8,8 12,4 16,8"/></g></svg>`;
  }

  function todayStr() {
    const d = new Date();
    const jst = new Date(d.getTime() + 9 * 3600000);
    return jst.toISOString().slice(0, 10);
  }

  // --- F12: API helper with content-type check ---
  async function api(path) {
    const resp = await fetch(`./api/${path}`);
    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('json')) {
      const body = await resp.text();
      throw new Error(body.slice(0, 200) || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
  }

  // --- Init ---
  async function init() {
    try {
      stations = await api('stations');
    } catch (e) {
      showError('ステーション一覧の取得に失敗: ' + e.message);
      return;
    }

    // Determine current station
    const urlParams = new URLSearchParams(window.location.search);
    const urlStation = urlParams.get('station');
    const savedStation = lsGet('weatherStation');
    const stationId = urlStation || savedStation || (stations[0] && stations[0].id);

    currentStation = stations.find(s => s.id === stationId) || stations[0];
    if (currentStation) {
      lsSet('weatherStation', currentStation.id);
    }

    setupStationSelect();
    setupPeriodSelector();
    setupPageDots();
    setupSettings();
    setupDateModal();
    setupFontScale();

    await refresh();
    startPolling();
    setupVisibility();
  }

  function showError(msg) {
    const el = $('#errorMsg');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 8000);
  }

  // --- Station select ---
  function setupStationSelect() {
    const sel = $('#stationSelect');
    sel.innerHTML = '';
    stations.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.label} (${s.location})`;
      if (currentStation && s.id === currentStation.id) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
      currentStation = stations.find(s => s.id === sel.value);
      lsSet('weatherStation', currentStation.id);
      refresh();
    });
  }

  // --- Period selector ---
  const PERIODS = [
    { key: '24h', label: '24h' },
    { key: '1d', label: '1日' },
    { key: '1w', label: '1週' },
    { key: '2w', label: '2週' },
    { key: '1mo', label: '1月' },
    { key: '6mo', label: '半年' },
    { key: '1y', label: '1年' },
    { key: 'custom', label: '期間指定' },
  ];

  function setupPeriodSelector() {
    ['periodSelector', 'periodSelector2'].forEach(containerId => {
      const container = document.getElementById(containerId);
      container.innerHTML = '';
      PERIODS.forEach(p => {
        const btn = document.createElement('button');
        btn.className = 'pill' + (p.key === selectedRange ? ' active' : '');
        btn.textContent = p.label;
        btn.dataset.range = p.key;
        btn.addEventListener('click', () => onPeriodClick(p.key));
        container.appendChild(btn);
      });
    });
  }

  function onPeriodClick(key) {
    if (key === 'custom') {
      openDateModal();
      return;
    }
    selectedRange = key;
    customEndDate = null;
    customRange = null;
    lsSet('weatherRange', key);
    updatePillActive();
    fetchHistory();
  }

  function updatePillActive() {
    $$('.pill').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.range === selectedRange);
    });
  }

  // --- Date modal ---
  function setupDateModal() {
    $('#customEndDate').value = todayStr();
    $('#btnDateCancel').addEventListener('click', () => {
      $('#dateModal').classList.remove('show');
    });
    $('#btnDateApply').addEventListener('click', () => {
      customEndDate = $('#customEndDate').value || todayStr();
      customRange = $('#customRange').value;
      selectedRange = 'custom';
      lsSet('weatherRange', 'custom');
      updatePillActive();
      $('#dateModal').classList.remove('show');
      fetchHistory();
    });
  }

  function openDateModal() {
    $('#dateModal').classList.add('show');
  }

  // --- Page dots ---
  function setupPageDots() {
    const pages = $('#pages');
    const dots = $$('#pageDots .dot');
    pages.addEventListener('scroll', () => {
      const idx = Math.round(pages.scrollLeft / window.innerWidth);
      dots.forEach((d, i) => d.classList.toggle('active', i === idx));
    });
  }

  // --- Settings ---
  function setupSettings() {
    const intSel = $('#intervalSelect');
    intSel.value = String(pollInterval);
    intSel.addEventListener('change', () => {
      pollInterval = parseInt(intSel.value, 10);
      lsSet('weatherInterval', String(pollInterval));
      startPolling();
    });

    $('#btnReload').addEventListener('click', () => refresh());
  }

  // --- Font scale ---
  function applyFontScale(scale) {
    fontScale = scale;
    document.documentElement.style.setProperty('--font-scale', scale);
    lsSet('weatherFontScale', String(scale));

    // Update Chart.js global font size and redraw all charts
    if (typeof Chart !== 'undefined') {
      Chart.defaults.font.size = Math.round(12 * scale);
      Object.values(charts).forEach(c => c.update());
    }
  }

  function setupFontScale() {
    applyFontScale(fontScale);

    const container = $('#fontScaleSelector');
    if (!container) return;
    const buttons = container.querySelectorAll('.pill');
    buttons.forEach(btn => {
      btn.classList.toggle('active', parseFloat(btn.dataset.scale) === fontScale);
      btn.addEventListener('click', () => {
        const scale = parseFloat(btn.dataset.scale);
        applyFontScale(scale);
        buttons.forEach(b => b.classList.toggle('active', parseFloat(b.dataset.scale) === scale));
      });
    });
  }

  // --- Polling ---
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    if (pollInterval > 0) {
      pollTimer = setInterval(() => fetchCurrent(), pollInterval * 1000);
    }
  }

  function setupVisibility() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
      } else {
        fetchCurrent();
        startPolling();
      }
    });
  }

  // --- Data fetching ---
  async function refresh() {
    await Promise.all([fetchCurrent(), fetchHistory()]);
  }

  async function fetchCurrent() {
    if (!currentStation) return;
    try {
      currentObs = await api(`observations/current?stationId=${currentStation.id}`);
      renderCurrent();
      $('#lastUpdated').textContent = '最終取得: ' + new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' });
    } catch (e) {
      showError('現在値の取得に失敗: ' + e.message);
    }
  }

  async function fetchHistory() {
    if (!currentStation) return;

    const range = selectedRange === 'custom' ? (customRange || '1w') : selectedRange;
    const endDate = selectedRange === 'custom' ? (customEndDate || todayStr()) : todayStr();

    showChartLoading(true);

    try {
      const params = `stationId=${currentStation.id}&range=${range}&endDate=${endDate}`;
      historyData = await api(`observations/history?${params}`);
      renderCharts();

      const showPartial = historyData.partial;
      $('#partialBanner').classList.toggle('show', showPartial);
      $('#partialBanner2').classList.toggle('show', showPartial);
    } catch (e) {
      showError('履歴データの取得に失敗: ' + e.message);
    } finally {
      showChartLoading(false);
    }
  }

  function showChartLoading(show) {
    ['loadingTemp', 'loadingPressure', 'loadingHumidity', 'loadingWind', 'loadingWindDir', 'loadingRain'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = show ? 'flex' : 'none';
    });
  }

  // --- F8: Safe numeric display ---
  function safeNum(v, dec) {
    if (v == null) return '--';
    const n = Number(v);
    if (!isFinite(n)) return '--';
    return n.toFixed(dec ?? 1);
  }

  // --- Render current ---
  function renderCurrent() {
    if (!currentStation || !currentObs) return;

    $('#stationLabel').textContent = currentStation.label;
    $('#stationLocation').textContent = currentStation.location;
    $('#stationIdDisplay').textContent = currentObs.stationId || currentStation.id;
    $('#obsTime').textContent = fmtTime(currentObs.obsTimeLocal);

    // F8: use safeNum for upstream numeric values
    $('#valTemp').textContent = safeNum(currentObs.tempC);
    $('#valDewpt').textContent = safeNum(currentObs.dewptC);
    $('#valHumidity').textContent = safeNum(currentObs.humidity, 0);
    $('#valPressure').textContent = safeNum(currentObs.pressureHpa, 1);
    $('#valWind').textContent = safeNum(currentObs.windSpeedMs);
    $('#valGust').textContent = safeNum(currentObs.windGustMs);
    $('#valRain').textContent = safeNum(currentObs.precipTotalMm);
    $('#valSolar').textContent = safeNum(currentObs.solarRadiationWm2, 0);

    // F8: windDir sanitized in windArrowSvg
    $('#windPip').innerHTML = windArrowSvg(currentObs.windDir);
    $('#windDirText').textContent = currentObs.windDir != null ? `${windDirName(currentObs.windDir)} (${currentObs.windDir}°)` : '--';
    $('#rainRate').textContent = currentObs.precipRateMmH != null ? `${safeNum(currentObs.precipRateMmH)} mm/h` : '';
    $('#uvIndex').textContent = currentObs.uv != null ? `UV: ${currentObs.uv}` : '';

    renderMinMax();
  }

  // F8: Build min/max DOM elements safely (no innerHTML for data values)
  function buildMmElement(mm, unit, dec) {
    if (!mm) return null;
    const frag = document.createDocumentFragment();
    if (mm.max != null) {
      const line = document.createElement('span');
      line.textContent = `▲ ${safeNum(mm.max, dec)} ${unit} (${fmtTimeShort(mm.maxTime)})`;
      frag.appendChild(line);
    }
    if (mm.min != null) {
      if (frag.childNodes.length > 0) {
        frag.appendChild(document.createElement('br'));
      }
      const line = document.createElement('span');
      line.textContent = `▼ ${safeNum(mm.min, dec)} ${unit} (${fmtTimeShort(mm.minTime)})`;
      frag.appendChild(line);
    }
    return frag;
  }

  function renderMinMax() {
    if (!historyData || !historyData.points || historyData.points.length === 0) return;
    const pts = historyData.points;
    const g = historyData.granularity;

    const tempKey = g === 'day' ? 'tempMaxC' : 'tempC';
    const tempMinKey = g === 'day' ? 'tempMinC' : 'tempC';
    const dewptKey = g === 'day' ? 'dewptAvgC' : 'dewptC';
    const humKey = g === 'day' ? 'humidityAvg' : 'humidity';
    const pressKey = 'pressureHpa';
    const windKey = g === 'day' ? 'windSpeedAvgMs' : 'windSpeedMs';
    const gustKey = g === 'day' ? 'windGustMaxMs' : 'windGustMs';
    const rainKey = 'precipTotalMm';
    const solarKey = g === 'day' ? null : 'solarRadiationWm2';

    function minMax(key, minKey) {
      const valid = pts.filter(p => p[key] != null);
      if (valid.length === 0) return null;
      const maxP = valid.reduce((a, b) => (b[key] > a[key] ? b : a));
      const useMinKey = minKey || key;
      const validMin = pts.filter(p => p[useMinKey] != null);
      const minP = validMin.length > 0 ? validMin.reduce((a, b) => (b[useMinKey] < a[useMinKey] ? b : a)) : null;
      return {
        max: maxP[key],
        maxTime: maxP.tsLocal,
        min: minP ? minP[useMinKey] : null,
        minTime: minP ? minP.tsLocal : null,
      };
    }

    function setMm(sel, mm, unit, dec) {
      const el = $(sel);
      el.textContent = '';
      const frag = buildMmElement(mm, unit, dec);
      if (frag) el.appendChild(frag);
    }

    setMm('#mmTemp', minMax(tempKey, tempMinKey), '°C', 1);
    setMm('#mmDewpt', minMax(dewptKey), '°C', 1);
    setMm('#mmHumidity', minMax(humKey), '%', 0);
    setMm('#mmPressure', minMax(pressKey), 'hPa', 1);
    setMm('#mmWind', minMax(windKey), 'm/s', 1);
    setMm('#mmGust', minMax(gustKey), 'm/s', 1);
    setMm('#mmRain', minMax(rainKey), 'mm', 1);
    if (solarKey) {
      setMm('#mmSolar', minMax(solarKey), 'W/m²', 0);
    } else {
      $('#mmSolar').textContent = '';
    }
  }

  // --- Charts ---
  const chartColors = {
    temp: '#ff6b6b',
    dewpt: '#4da6ff',
    pressure: '#2ed573',
    humidity: '#4da6ff',
    wind: '#4da6ff',
    gust: '#ff9f43',
    windDir: '#4da6ff',
    rain: '#4da6ff',
  };

  const chartDefaults = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    interaction: { intersect: false, mode: 'index' },
    plugins: {
      legend: { display: true, labels: { color: '#8899bb', font: { size: 10 }, boxWidth: 12 } },
      tooltip: {
        backgroundColor: '#132952',
        titleColor: '#e8edf5',
        bodyColor: '#e8edf5',
        borderColor: '#1e3a6e',
        borderWidth: 1,
        titleFont: { size: 11 },
        bodyFont: { size: 11 },
      },
    },
    scales: {
      x: {
        ticks: { color: '#8899bb', font: { size: 9 }, maxTicksLimit: 8, maxRotation: 0 },
        grid: { color: 'rgba(30,58,110,0.3)' },
      },
      y: {
        ticks: { color: '#8899bb', font: { size: 10 } },
        grid: { color: 'rgba(30,58,110,0.3)' },
      },
    },
  };

  function parseLabel(tsLocal, granularity) {
    if (!tsLocal) return '';
    try {
      const d = new Date(tsLocal);
      if (granularity === 'day') {
        return d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Tokyo' });
      }
      return d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });
    } catch { return tsLocal; }
  }

  function createOrUpdate(chartId, canvasId, config) {
    if (charts[chartId]) {
      charts[chartId].destroy();
    }
    const ctx = document.getElementById(canvasId).getContext('2d');
    charts[chartId] = new Chart(ctx, config);
  }

  function renderCharts() {
    if (!historyData || !historyData.points) return;
    const pts = historyData.points;
    const g = historyData.granularity;
    const labels = pts.map(p => parseLabel(p.tsLocal, g));

    const tempData = g === 'day' ? pts.map(p => p.tempAvgC ?? p.tempMaxC) : pts.map(p => p.tempC);
    const dewptData = g === 'day' ? pts.map(p => p.dewptAvgC) : pts.map(p => p.dewptC);

    createOrUpdate('temp', 'chartTemp', {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: '気温', data: tempData, borderColor: chartColors.temp, backgroundColor: 'rgba(255,107,107,0.1)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5 },
          { label: '露点', data: dewptData, borderColor: chartColors.dewpt, backgroundColor: 'rgba(77,166,255,0.1)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5 },
        ],
      },
      options: { ...chartDefaults },
    });

    const pressureData = pts.map(p => p.pressureHpa);
    createOrUpdate('pressure', 'chartPressure', {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: '気圧', data: pressureData, borderColor: chartColors.pressure, backgroundColor: 'rgba(46,213,115,0.1)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5 },
        ],
      },
      options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, legend: { display: false } } },
    });

    const humData = g === 'day' ? pts.map(p => p.humidityAvg) : pts.map(p => p.humidity);
    createOrUpdate('humidity', 'chartHumidity', {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: '湿度', data: humData, borderColor: chartColors.humidity, backgroundColor: 'rgba(77,166,255,0.1)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5 },
        ],
      },
      options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, legend: { display: false } } },
    });

    const windData = g === 'day' ? pts.map(p => p.windSpeedAvgMs) : pts.map(p => p.windSpeedMs);
    const gustData = g === 'day' ? pts.map(p => p.windGustMaxMs) : pts.map(p => p.windGustMs);
    createOrUpdate('wind', 'chartWind', {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: '風速', data: windData, borderColor: chartColors.wind, tension: 0.3, pointRadius: 0, borderWidth: 1.5, fill: false },
          { label: '突風', data: gustData, borderColor: chartColors.gust, tension: 0.3, pointRadius: 0, borderWidth: 1.5, fill: false },
        ],
      },
      options: { ...chartDefaults },
    });

    const windDirData = pts.map((p, i) => ({ x: i, y: p.windDir })).filter(d => d.y != null);
    createOrUpdate('windDir', 'chartWindDir', {
      type: 'scatter',
      data: {
        datasets: [{
          label: '風向',
          data: windDirData,
          backgroundColor: chartColors.windDir,
          pointRadius: 2,
        }],
      },
      options: {
        ...chartDefaults,
        plugins: { ...chartDefaults.plugins, legend: { display: false } },
        scales: {
          x: {
            ...chartDefaults.scales.x,
            type: 'linear',
            ticks: {
              ...chartDefaults.scales.x.ticks,
              callback: function(value) {
                const idx = Math.round(value);
                if (idx >= 0 && idx < labels.length) return labels[idx];
                return '';
              },
            },
          },
          y: {
            ...chartDefaults.scales.y,
            min: 0,
            max: 360,
            ticks: {
              ...chartDefaults.scales.y.ticks,
              stepSize: 90,
              callback: function(v) {
                const d = { 0: 'N', 90: 'E', 180: 'S', 270: 'W', 360: 'N' };
                return d[v] || v;
              },
            },
          },
        },
      },
    });

    const rainData = pts.map(p => p.precipTotalMm);
    createOrUpdate('rain', 'chartRain', {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: '雨量', data: rainData, backgroundColor: 'rgba(77,166,255,0.6)', borderColor: chartColors.rain, borderWidth: 1 },
        ],
      },
      options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, legend: { display: false } } },
    });

    renderMinMax();
  }

  // --- Service Worker ---
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // --- Start ---
  init();
})();
