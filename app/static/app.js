const state = { dashboard: null, rmsPoints: [], mapAlerts: [], selectedGateway: '' };
const defaultGatewayIds = ['GW_UABAMS_BOGIE_01', 'GW_UABAMS_BOGIE_02'];
const gatewayIds = defaultGatewayIds;
let dashboardGatewayIds = [...defaultGatewayIds];
const maps = {};
const layers = {};
const trainMarkers = {};
let autoRefreshTimer = null;
let lastLoadedTrainNo = "";
const recentTrainStorageKey = 'uabams_recent_train_numbers';

const $ = (id) => document.getElementById(id);

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function setHtml(id, value) {
  const el = $(id);
  if (el) el.innerHTML = value;
}

function setClass(id, value) {
  const el = $(id);
  if (el) el.className = value;
}

function setStatus(text, mode = '') {
  setText('apiStatus', text);
  setClass('apiStatus', `status-pill ${mode}`.trim());
}

async function logClientEvent(action, details = {}) {
  try {
    await fetch('/api/v1/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        page: location.pathname + location.hash,
        action,
        message: details.message || null,
        errorMessage: details.errorMessage || null,
        latitude: details.latitude ?? null,
        longitude: details.longitude ?? null,
      }),
    });
  } catch {
    // Logging must never break the dashboard.
  }
}

function logBrowserLocation(action) {
  if (!navigator.geolocation) {
    logClientEvent(action);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (position) => logClientEvent(action, { latitude: position.coords.latitude, longitude: position.coords.longitude }),
    () => logClientEvent(action),
    { maximumAge: 300000, timeout: 3000 }
  );
}

function selectedGatewayValue() {
  return $('dashboardGateway')?.value || '';
}

function visibleGatewayIds() {
  const selected = selectedGatewayValue();
  return selected ? [selected] : dashboardGatewayIds;
}

function gatewayLabel(gatewayId) {
  const index = dashboardGatewayIds.indexOf(gatewayId);
  if (index >= 0) return `GW${index + 1}`;
  const fallbackIndex = defaultGatewayIds.indexOf(gatewayId);
  return fallbackIndex >= 0 ? `GW${fallbackIndex + 1}` : gatewayId;
}

function trainNoValue() {
  return $('trainNo')?.value.trim() || '';
}


function recentTrainNumbers() {
  try {
    const values = JSON.parse(localStorage.getItem(recentTrainStorageKey) || '[]');
    return Array.isArray(values) ? values.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function renderRecentTrainNumbers() {
  const list = $('recentTrainNos');
  const input = $('trainNo');

  if (!list || !input) return;

  const localTrains = recentTrainNumbers();
  const renderList = (allTrains) => {
    list.innerHTML = allTrains
      .map((trainNo) => `<option value="${escapeHtml(trainNo)}"></option>`)
      .join('');
    if (allTrains.length > 0 && !input.value) {
      input.value = allTrains[0];
    }
  };

  renderList(localTrains);

  fetch('/api/v1/trains')
    .then((res) => res.json())
    .then((serverTrains) => {
      if (Array.isArray(serverTrains)) {
        const combined = Array.from(new Set([...localTrains, ...serverTrains]));
        renderList(combined);
      }
    })
    .catch((err) => console.error('Failed to load train list:', err));
}

function rememberTrainNumber(trainNo) {
  const cleanTrainNo = String(trainNo || '').trim();
  if (!cleanTrainNo) return;

  localStorage.setItem(recentTrainStorageKey, JSON.stringify([cleanTrainNo]));
  renderRecentTrainNumbers();
}

function gatewayApiKey(gatewayId) {
  const card = cardFor(gatewayId);
  const inputValue = field(card, 'apiKey')?.value.trim();
  if (inputValue) {
    localStorage.setItem(`uabams_api_key_${gatewayId}`, inputValue);
    return inputValue;
  }
  return localStorage.getItem(`uabams_api_key_${gatewayId}`) || '';
}

function gatewayHeaders(gatewayId) {
  const apiKey = gatewayApiKey(gatewayId);
  return apiKey ? { 'X-Api-Key': apiKey } : {};
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function collectGatewayIds(data) {
  const trainIds = Array.isArray(data.train?.gateways) ? data.train.gateways : [];
  const statusIds = Array.isArray(data.gateways) ? data.gateways.map((gw) => gw.gatewayId) : [];
  const ids = [...trainIds, ...statusIds].filter(Boolean);
  return [...new Set(ids)];
}

function updateGatewaySelector(data) {
  const select = $('dashboardGateway');
  if (!select) return;
  const previous = select.value;
  const ids = collectGatewayIds(data);
  dashboardGatewayIds = ids.length ? ids : [...defaultGatewayIds];
  const optionsHtml = [
    '<option value="">All Gateways</option>',
    ...dashboardGatewayIds.map((gatewayId) => `<option value="${escapeHtml(gatewayId)}">${escapeHtml(`${gatewayLabel(gatewayId)} - ${gatewayId}`)}</option>`),
  ].join('');
  select.innerHTML = optionsHtml;
  select.value = dashboardGatewayIds.includes(previous) ? previous : '';

  const cleanup = $('cleanupGateway');
  if (cleanup) {
    const cleanupPrevious = cleanup.value;
    cleanup.innerHTML = optionsHtml;
    cleanup.value = dashboardGatewayIds.includes(cleanupPrevious) ? cleanupPrevious : '';
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const detail = data && data.detail ? data.detail : response.statusText;
    logClientEvent('fetch_error', { message: url, errorMessage: `${response.status} ${detail}` });
    throw new Error(`${response.status} ${detail}`);
  }
  return data;
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function bytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size)) return '-';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function alertColor(alertType) {
  if (alertType === 'RED') return '#dc2626';
  if (alertType === 'YELLOW') return '#f59e0b';
  return '#16a34a';
}

function normalizeAlert(value) {
  return String(value || 'GREEN').toUpperCase();
}

function lastDataTime(train, gateways, alerts, archives) {
  return train.updatedAt || archives[0]?.receivedAt || gateways.find((gw) => gw.lastHeartbeat)?.lastHeartbeat || alerts[0]?.createdAt;
}

function latestAlertFor(alerts, gatewayId) {
  return alerts.find((alert) => alert.gatewayId === gatewayId) || null;
}

function archiveCountFor(archives, gatewayId) {
  return archives.filter((archive) => archive.gatewayId === gatewayId).length;
}

function renderGatewayCards(gatewayIdsToShow, gateways = [], train = {}, alerts = [], archives = []) {
  setHtml('gatewayList', gatewayIdsToShow.map((gatewayId) => {
    const gw = gateways.find((item) => item.gatewayId === gatewayId) || { gatewayId, trainId: train.trainNo, online: false };
    const latest = latestAlertFor(alerts, gatewayId);
    const alertStatus = normalizeAlert(latest?.alert);
    const statusClass = gw.online ? 'online-box' : 'offline-box';
    return `
      <article class="gateway-card ${statusClass}">
        <div class="gateway-title">
          <span>${gatewayLabel(gatewayId)} - ${gatewayId}</span>
          <span class="badge ${gw.online ? 'online' : 'offline'}">${gw.online ? 'Online' : 'Offline'}</span>
        </div>
        <div class="gateway-kpis">
          <div><span>Train</span><strong>${train.trainNo || gw.trainId || '-'}</strong></div>
          <div><span>Latest Peak</span><strong>${latest ? `${latest.peakValueG} G` : '-'}</strong></div>
          <div class="alert-kpi ${latest ? alertStatus : ''}"><span>Alert</span><strong>${latest ? alertStatus : '-'}</strong></div>
          <div><span>Archives</span><strong>${archiveCountFor(archives, gatewayId)}</strong></div>
        </div>
        <div>Last heartbeat: ${formatDate(gw.lastHeartbeat)}</div>
        <div>Last alert location: ${latest ? `${latest.latitude}, ${latest.longitude}` : '-'}</div>
      </article>
    `;
  }).join(''));
}

function initializeMaps() {
  if (!window.L) {
    gatewayIds.forEach((id) => {
      const target = id === 'GW_UABAMS_BOGIE_02' ? 'mapGw2' : 'mapGw1';
      setHtml(target, '<div class="empty-state">Leaflet map failed to load</div>');
    });
    return;
  }

  [
    { gatewayId: 'GW_UABAMS_BOGIE_01', target: 'mapGw1' },
    { gatewayId: 'GW_UABAMS_BOGIE_02', target: 'mapGw2' },
  ].forEach(({ gatewayId, target }) => {
    if (!$(target)) return;
    maps[gatewayId] = L.map(target, { zoomControl: true }).setView([22.9734, 78.6569], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(maps[gatewayId]);
    layers[gatewayId] = L.layerGroup().addTo(maps[gatewayId]);
  });
}

function refreshVisibleMaps(delay = 120) {
  setTimeout(() => {
    visibleGatewayIds().forEach((gatewayId) => maps[gatewayId]?.invalidateSize());
  }, delay);
}

function dashboardAlertToMapPoint(alert) {
  return {
    gateway_id: alert.gatewayId,
    lat: alert.latitude,
    lon: alert.longitude,
    color: alert.alert,
    peak_g: alert.peakValueG,
    speed_kmph: alert.speedKmph,
    position_mm: alert.positionMm,
    created_at: alert.createdAt,
    source: 'alert',
  };
}

function jitterPoint(lat, lon, index) {
  const offset = index * 0.0008;
  return [Number(lat) + offset, Number(lon) + offset];
}

function routePopup(point) {
  const positionKm = Number.isFinite(Number(point.position_mm)) ? `${(Number(point.position_mm) / 1000).toFixed(2)} km` : '-';
  return `
    <div class="leaflet-popup-content-box">
      <strong>${normalizeAlert(point.color)} - ${gatewayLabel(point.gateway_id)}</strong><br>
      <span>Session:</span> ${point.session || '-'}<br>
      <span>Peak:</span> ${point.peak_g ?? '-'} G<br>
      <span>Position:</span> ${positionKm}<br>
      <span>Location:</span> ${point.lat}, ${point.lon}
    </div>
  `;
}

function gatewayMatches(item, gatewayId) {
  return !gatewayId || item.gatewayId === gatewayId || item.gateway_id === gatewayId;
}

function setGatewayDetailVisible(visible) {
  const section = $('dashboardGatewayDetails');
  if (section) section.classList.toggle('hidden', !visible);
}

function syncCleanupGateway() {
  const selected = selectedGatewayValue();
  const cleanup = $('cleanupGateway');
  if (cleanup) cleanup.value = selected;
}
function syncCalibrationGateway() {
  const visibleIds = visibleGatewayIds();
  document.querySelectorAll('.calibration-card').forEach((card) => {
    card.classList.toggle('hidden', !visibleIds.includes(card.dataset.gateway));
  });
  setText('loadAllCalibrationBtn', selectedGatewayValue() ? 'Load Selected' : 'Load All');
}

function renderDashboard(data) {
  state.dashboard = data;
  updateGatewaySelector(data);
  const selectedGateway = selectedGatewayValue();
  state.selectedGateway = selectedGateway;
  const train = data.train || {};
  const gateways = data.gateways || [];
  const alerts = data.lastAlerts || [];
  const archives = data.archives || [];
  const activeSession = data.activeSession;
  const rmsPoints = data.rmsPoints || [];
  const mapAlerts = data.mapAlerts || alerts.map(dashboardAlertToMapPoint);
  const allGatewayIds = dashboardGatewayIds;
  const viewGatewayIds = visibleGatewayIds();
  const allGateways = gateways.filter((gw) => allGatewayIds.includes(gw.gatewayId));
  const viewAlerts = alerts.filter((alert) => gatewayMatches(alert, selectedGateway));
  const viewArchives = archives.filter((archive) => gatewayMatches(archive, selectedGateway));
  const viewRmsPoints = rmsPoints.filter((point) => gatewayMatches(point, selectedGateway));
  const viewMapAlerts = mapAlerts.filter((point) => gatewayMatches(point, selectedGateway));
  const onlineCount = allGatewayIds.filter((gatewayId) => gateways.find((gw) => gw.gatewayId === gatewayId)?.online).length;
  const criticalCount = alerts.filter((alert) => alert.alert === 'RED').length;
  setText('summaryTrain', train.trainNo || '-');
  setText('summaryStatus', train.status || '-');
  setText('summaryGateways', `${onlineCount}/${allGatewayIds.length || 0}`);
  setText('summaryLastData', formatDate(lastDataTime(train, allGateways, alerts, archives)));
  setText('summaryArchives', archives.length);
  setText('summaryCritical', criticalCount);

  setHtml('gatewayList', allGatewayIds.map((gatewayId) => {
    const gw = gateways.find((item) => item.gatewayId === gatewayId) || { gatewayId, trainId: train.trainNo, online: false };
    const latest = latestAlertFor(alerts, gatewayId);
    const alertStatus = normalizeAlert(latest?.alert);
    const statusClass = gw.online ? 'online-box' : 'offline-box';
    return `
      <article class="gateway-card ${statusClass}">
        <div class="gateway-title">
          <span>${gatewayLabel(gatewayId)} - ${gatewayId}</span>
          <span class="badge ${gw.online ? 'online' : 'offline'}">${gw.online ? 'Online' : 'Offline'}</span>
        </div>
        <div class="gateway-kpis">
          <div><span>Train</span><strong>${train.trainNo || gw.trainId || '-'}</strong></div>
          <div><span>Latest Peak</span><strong>${latest ? `${latest.peakValueG} G` : '-'}</strong></div>
          <div class="alert-kpi ${latest ? alertStatus : ''}"><span>Alert</span><strong>${latest ? alertStatus : '-'}</strong></div>
          <div><span>Archives</span><strong>${archiveCountFor(archives, gatewayId)}</strong></div>
        </div>
        <div>Last heartbeat: ${formatDate(gw.lastHeartbeat)}</div>
        <div>Last alert location: ${latest ? `${latest.latitude}, ${latest.longitude}` : '-'}</div>
      </article>
    `;
  }).join(''));

  setGatewayDetailVisible(false);
  syncCleanupGateway();
  syncCalibrationGateway();
  renderAlertSummary(viewAlerts);
  renderAlerts(viewAlerts);
  renderArchives(viewArchives);
  renderSession(activeSession, train.trainNo);
  renderMaps(viewAlerts, gateways, viewRmsPoints, viewMapAlerts);
}
function renderAlertSummary(alerts) {
  const red = alerts.filter((alert) => alert.alert === 'RED').length;
  const yellow = alerts.filter((alert) => alert.alert === 'YELLOW').length;
  const green = alerts.filter((alert) => alert.alert === 'GREEN').length;
  setText('alertTotal', alerts.length);
  setText('alertRed', red);
  setText('alertYellow', yellow);
  setText('alertGreen', green);
}

function renderAlerts(alerts) {
  setHtml('alertsTable', alerts.length ? alerts.map((alert) => `
    <tr>
      <td>${formatDate(alert.createdAt)}</td>
      <td>${alert.gatewayId || '-'}</td>
      <td>${alert.peakValueG ?? '-'}</td>
      <td><span class="badge ${alert.alert}">${alert.alert || '-'}</span></td>
      <td>${alert.latitude ?? '-'}, ${alert.longitude ?? '-'}</td>
    </tr>
  `).join('') : '<tr><td colspan="5">No alerts found.</td></tr>');
}

function pointInRouteBounds(point, routePoints, padding = 0.035) {
  if (!routePoints.length) return true;
  const lats = routePoints.map((item) => Number(item.lat));
  const lons = routePoints.map((item) => Number(item.lon));
  const minLat = Math.min(...lats) - padding;
  const maxLat = Math.max(...lats) + padding;
  const minLon = Math.min(...lons) - padding;
  const maxLon = Math.max(...lons) + padding;
  const lat = Number(point.lat);
  const lon = Number(point.lon);
  return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
}

function routeBearing(previous, current) {
  const lat1 = Number(previous.lat) * Math.PI / 180;
  const lat2 = Number(current.lat) * Math.PI / 180;
  const deltaLon = (Number(current.lon) - Number(previous.lon)) * Math.PI / 180;
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function addDirectionArrow(layer, previous, current, severity) {
  const midLat = (Number(previous.lat) + Number(current.lat)) / 2;
  const midLon = (Number(previous.lon) + Number(current.lon)) / 2;
  const bearing = routeBearing(previous, current);
  L.marker([midLat, midLon], {
    interactive: false,
    icon: L.divIcon({
      className: 'direction-arrow',
      html: `<span style="transform: rotate(${bearing}deg); color: ${alertColor(severity)}">&#9650;</span>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    }),
  }).addTo(layer);
}

function trainIconHtml(bearing) {
  const rotation = Number.isFinite(Number(bearing)) ? Number(bearing) : 0;
  return `<div class="train-position-icon" style="transform: rotate(${rotation}deg)">&#9650;</div>`;
}

function drawColoredRoute(layer, points) {
  if (!layer || points.length < 2) return;
  const latLngs = points.map((point) => [Number(point.lat), Number(point.lon)]);
  L.polyline(latLngs, {
    color: '#2f241f',
    weight: 18,
    opacity: 0.58,
    lineCap: 'round',
    lineJoin: 'round',
    smoothFactor: 1.2,
    className: 'route-line-shadow',
  }).addTo(layer);

  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    const severity = normalizeAlert(current.color);
    L.polyline(
      [[Number(previous.lat), Number(previous.lon)], [Number(current.lat), Number(current.lon)]],
      {
        color: alertColor(severity),
        weight: severity === 'RED' ? 13 : 12,
        opacity: 0.96,
        lineCap: 'round',
        lineJoin: 'round',
        smoothFactor: 1.2,
        className: 'route-line',
      }
    ).addTo(layer);
    if (i % 8 === 0 || severity === 'RED') addDirectionArrow(layer, previous, current, severity);
  }
}

function renderMaps(alerts, gateways, rmsPoints = [], mapAlerts = []) {
  const selectedGateway = selectedGatewayValue();
  const visibleIds = visibleGatewayIds();
  const validRmsPoints = rmsPoints
    .filter((point) => Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lon)));

  gatewayIds.forEach((gatewayId) => {
    const card = document.querySelector(`[data-map-gateway="${gatewayId}"]`);
    if (card) card.classList.toggle('hidden', !visibleIds.includes(gatewayId));

    const map = maps[gatewayId];
    const layer = layers[gatewayId];
    if (!map || !layer || !window.L) return;
    layer.clearLayers();
    if (!visibleIds.includes(gatewayId)) return;

    const routePoints = validRmsPoints.filter((point) => point.gateway_id === gatewayId);
    const rawAlertPoints = (mapAlerts.length ? mapAlerts : alerts.map(dashboardAlertToMapPoint))
      .filter((point) => point.gateway_id === gatewayId)
      .filter((point) => ['RED', 'YELLOW', 'GREEN'].includes(normalizeAlert(point.color)))
      .filter((point) => Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lon)))
      .slice()
      .reverse();
    const alertPoints = routePoints.length > 1
      ? rawAlertPoints.filter((point) => pointInRouteBounds(point, routePoints))
      : rawAlertPoints;

    const stateId = gatewayId === 'GW_UABAMS_BOGIE_02' ? 'gw2MapState' : 'gw1MapState';
    const gw = gateways.find((item) => item.gatewayId === gatewayId);
    setText(stateId, gw?.online ? 'Online' : 'Offline');
    setClass(stateId, `badge ${gw?.online ? 'online' : 'offline'}`);

    if (!routePoints.length && !alertPoints.length) {
      map.setView([22.9734, 78.6569], 5);
      return;
    }

    drawColoredRoute(layer, routePoints);

    alertPoints.forEach((point, index) => {
      const markerPoint = jitterPoint(point.lat, point.lon, index);
      const severity = normalizeAlert(point.color);
      L.circleMarker(markerPoint, {
        radius: 13,
        color: '#111827',
        weight: 2,
        fillColor: alertColor(severity),
        fillOpacity: 1,
      })
        .addTo(layer)
        .bindPopup(routePopup(point));
    });

    const bounds = L.latLngBounds([
      ...routePoints.map((point) => [Number(point.lat), Number(point.lon)]),
      ...alertPoints.map((point, index) => jitterPoint(point.lat, point.lon, index)),
    ]);
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(selectedGateway ? 0.3 : 0.2), { maxZoom: 16 });
    }
  });
  refreshVisibleMaps();
}
function clearHiddenTrainMarkers(visibleIds) {
  Object.entries(trainMarkers).forEach(([gatewayId, marker]) => {
    if (!visibleIds.includes(gatewayId)) {
      marker.remove();
      delete trainMarkers[gatewayId];
    }
  });
}

async function renderGatewayTrainPosition(trainNo, gatewayId) {
  try {
    const data = await requestJson(`/api/v1/trains/${encodeURIComponent(trainNo)}/position?gateway_id=${encodeURIComponent(gatewayId)}`);
    const point = data.position;
    if (!point || !data.gatewayId || !maps[data.gatewayId]) return;
    const map = maps[data.gatewayId];
    const oldMarker = trainMarkers[data.gatewayId];
    if (oldMarker) oldMarker.remove();
    trainMarkers[data.gatewayId] = L.marker([point.latitude, point.longitude], {
      icon: L.divIcon({
        className: '',
        html: trainIconHtml(point.bearing),
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      }),
      zIndexOffset: 900,
    }).addTo(map).bindPopup(`Current train position<br>Gateway: ${data.gatewayId}<br>Speed: ${point.speedKmph ?? '-'} kmph<br>Position: ${point.positionMm ?? '-'} mm`);
  } catch (error) {
    logClientEvent('position_error', { message: gatewayId, errorMessage: error.message });
  }
}

async function renderTrainPosition(trainNo) {
  if (!trainNo || !window.L) return;
  const visibleIds = visibleGatewayIds();
  clearHiddenTrainMarkers(visibleIds);
  await Promise.all(visibleIds.map((gatewayId) => renderGatewayTrainPosition(trainNo, gatewayId)));
}

function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    if (lastLoadedTrainNo) loadDashboard({ silent: true });
  }, 8000);
}

async function loadLogs() {
  try {
    const data = await requestJson('/api/v1/logs?limit=100');
    const rows = data.logs || [];
    setHtml('logsTable', rows.length ? rows.map((log) => `
      <tr>
        <td>${formatDate(log.createdAt)}</td>
        <td>${escapeHtml(log.username || '-')}</td>
        <td>${escapeHtml(log.page || '-')}</td>
        <td>${escapeHtml(log.action || '-')}</td>
        <td>${escapeHtml(log.errorMessage || '-')}</td>
        <td>${escapeHtml(log.ipAddress || '-')}</td>
        <td>${log.latitude && log.longitude ? `${log.latitude}, ${log.longitude}` : '-'}</td>
      </tr>
    `).join('') : '<tr><td colspan="7">No logs found.</td></tr>');
  } catch (error) {
    setHtml('logsTable', `<tr><td colspan="7" class="error-text">${escapeHtml(error.message)}</td></tr>`);
  }
}

function renderArchives(archives) {
  setHtml('archiveTable', archives.length ? archives.map((archive) => `
    <tr>
      <td>${formatDate(archive.receivedAt)}</td>
      <td>${archive.gatewayId || '-'}</td>
      <td>${bytes(archive.sizeBytes)}</td>
      <td>${archive.rmsRecordCount ?? 0}</td>
      <td>${archive.peakRecordCount ?? 0}</td>
      <td>${archive.faultRecordCount ?? 0}</td>
      <td>${archive.status || '-'}</td>
    </tr>
  `).join('') : '<tr><td colspan="7">No archives uploaded.</td></tr>');
}

function renderGatewayDetails(data) {
  const status = data.status || {};
  const summary = data.summary || {};
  const location = summary.latestLocation || {};
  setText('detailGatewayId', data.gatewayId || '-');
  setText('detailStatus', status.online ? 'Online' : 'Offline');
  setText('detailHeartbeat', formatDate(status.lastHeartbeat));
  setText('detailAlert', summary.latestAlert ? `${summary.latestAlert}${summary.latestPeakG ? ` (${summary.latestPeakG} G)` : ''}` : '-');
  setText('detailRms', summary.rmsRecords ?? '-');
  setText('detailPeak', summary.peakRecords ?? '-');
  setText('detailFaults', summary.faultRecords ?? '-');
  setText('detailArchives', summary.archives ?? '-');

  setHtml('detailAlertsTable', data.alerts?.length ? data.alerts.map((alert) => `
    <tr>
      <td>${formatDate(alert.createdAt)}</td>
      <td>${alert.peakValueG ?? '-'}</td>
      <td><span class="badge ${alert.alert}">${alert.alert || '-'}</span></td>
      <td>${alert.latitude ?? '-'}, ${alert.longitude ?? '-'}</td>
    </tr>
  `).join('') : '<tr><td colspan="4">No alerts for selected gateway.</td></tr>');

  setHtml('detailArchivesTable', data.archives?.length ? data.archives.map((archive) => `
    <tr>
      <td>${formatDate(archive.receivedAt)}</td>
      <td>${bytes(archive.sizeBytes)}</td>
      <td>${archive.rmsRecordCount ?? 0}</td>
      <td>${archive.peakRecordCount ?? 0}</td>
      <td>${archive.faultRecordCount ?? 0}</td>
      <td>${archive.status || '-'}</td>
    </tr>
  `).join('') : '<tr><td colspan="6">No archives for selected gateway.</td></tr>');
}

async function loadGatewayDetails() {
  const trainNo = trainNoValue();
  const gatewayId = selectedGatewayValue();
  if (!gatewayId) { setGatewayDetailVisible(false); return; }
  try {
    if (!options.silent) setStatus('Loading');
    const data = await requestJson(`/api/v1/trains/${encodeURIComponent(trainNo)}/gateways/${encodeURIComponent(gatewayId)}/details`);
    renderGatewayDetails(data);
    setStatus('Live', 'ok');
  } catch (error) {
    setStatus('Error', 'error');
    setHtml('detailAlertsTable', `<tr><td colspan="4" class="error-text">${error.message}</td></tr>`);
  }
}

function localDateTimeToIso(value) {
  return value ? new Date(value).toISOString() : null;
}

async function cleanupData() {
  const trainNo = trainNoValue();
  const latitudeText = $('cleanupLat')?.value.trim();
  const longitudeText = $('cleanupLon')?.value.trim();
  const payload = {
    trainNo,
    gatewayId: $('cleanupGateway')?.value || null,
    startTime: localDateTimeToIso($('cleanupStart')?.value),
    endTime: localDateTimeToIso($('cleanupEnd')?.value),
    latitude: latitudeText ? Number(latitudeText) : null,
    longitude: longitudeText ? Number(longitudeText) : null,
    radiusMeters: Number($('cleanupRadius')?.value || 100),
    reason: $('cleanupReason')?.value.trim() || null,
  };
  if (!payload.startTime && !payload.endTime && (payload.latitude === null || payload.longitude === null)) {
    setText('resetOutput', 'Provide a time range or latitude/longitude before deleting data.');
    return;
  }
  if (!confirm(`Delete matching data for train ${trainNo}?`)) return;
  try {
    const data = await requestJson('/api/v1/data/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': $('adminKey')?.value.trim() || '' },
      body: JSON.stringify(payload),
    });
    setText('resetOutput', JSON.stringify(data, null, 2));
    setStatus('Cleaned', 'ok');
    await loadDashboard();
    await loadGatewayDetails();
  } catch (error) {
    setStatus('Error', 'error');
    setText('resetOutput', error.message);
  }
}
function renderSession(session, trainNo) {
  setText('sessionText', session
    ? `Active session ${session.sessionId} for train ${trainNo}.`
    : `No active session for train ${trainNo || '-'}.`);
}

function calibrationCard(gatewayId) {
  const label = gatewayLabel(gatewayId);
  return `
    <article class="calibration-card" data-gateway="${gatewayId}">
      <div class="gateway-title">
        <span>${label} Calibration</span>
        <span class="badge offline" data-role="calStatus">Pending</span>
      </div>
      <label class="api-key-field">Gateway API Key<input data-field="apiKey" type="password" value="${escapeHtml(localStorage.getItem(`uabams_api_key_${gatewayId}`) || '')}" placeholder="Enter ${label} API key"></label>
      <label class="checkline"><input type="checkbox" data-field="routeComplete"> Destination reached</label>
      <div class="calibration-form compact-form">
        <label>Left Wheel Factor<input data-field="leftWheelFactor" type="number" step="0.001" value="1"></label>
        <label>Right Wheel Factor<input data-field="rightWheelFactor" type="number" step="0.001" value="1"></label>
        <label>ADXL Left X<input data-field="adxlLeftX" type="number" step="0.001" value="1"></label>
        <label>ADXL Left Y<input data-field="adxlLeftY" type="number" step="0.001" value="1"></label>
        <label>ADXL Left Z<input data-field="adxlLeftZ" type="number" step="0.001" value="1"></label>
        <label>ADXL Right X<input data-field="adxlRightX" type="number" step="0.001" value="1"></label>
        <label>ADXL Right Y<input data-field="adxlRightY" type="number" step="0.001" value="1"></label>
        <label>ADXL Right Z<input data-field="adxlRightZ" type="number" step="0.001" value="1"></label>
      </div>
      <div class="button-row">
        <button type="button" data-action="load" data-gateway="${gatewayId}">Load ${label}</button>
        <button type="button" class="primary" data-action="save" data-gateway="${gatewayId}">Save ${label}</button>
      </div>
      <pre class="output compact" data-role="calOutput"></pre>
    </article>
  `;
}

function buildCalibrationCards() {
  const pair = $('calibrationPair');
  if (!pair) return;
  pair.innerHTML = gatewayIds.map(calibrationCard).join('');
  pair.addEventListener('click', async (event) => {
    const action = event.target.dataset.action;
    const gatewayId = event.target.dataset.gateway;
    if (!action || !gatewayId) return;
    if (action === 'load') await loadCalibration(gatewayId);
    if (action === 'save') await saveCalibration(gatewayId);
  });
}

function cardFor(gatewayId) {
  return document.querySelector(`.calibration-card[data-gateway="${gatewayId}"]`);
}

function field(card, name) {
  return card?.querySelector(`[data-field="${name}"]`);
}

function setCalibrationValues(gatewayId, data) {
  const card = cardFor(gatewayId);
  if (!card) return;
  field(card, 'leftWheelFactor').value = data.leftWheelFactor ?? 1;
  field(card, 'rightWheelFactor').value = data.rightWheelFactor ?? 1;
  field(card, 'adxlLeftX').value = data.adxl_left?.x ?? data.adxlLeft?.x ?? 1;
  field(card, 'adxlLeftY').value = data.adxl_left?.y ?? data.adxlLeft?.y ?? 1;
  field(card, 'adxlLeftZ').value = data.adxl_left?.z ?? data.adxlLeft?.z ?? 1;
  field(card, 'adxlRightX').value = data.adxl_right?.x ?? data.adxlRight?.x ?? 1;
  field(card, 'adxlRightY').value = data.adxl_right?.y ?? data.adxlRight?.y ?? 1;
  field(card, 'adxlRightZ').value = data.adxl_right?.z ?? data.adxlRight?.z ?? 1;
}

async function loadCalibration(gatewayId) {
  const card = cardFor(gatewayId);
  const output = card?.querySelector('[data-role="calOutput"]');
  if (!gatewayApiKey(gatewayId)) {
    if (output) output.textContent = `Enter the API key for ${gatewayLabel(gatewayId)} before loading calibration.`;
    return;
  }

  try {
    const data = await requestJson(`/api/v1/calibration/${encodeURIComponent(gatewayId)}`, { headers: gatewayHeaders(gatewayId) });
    setCalibrationValues(gatewayId, data);
    if (output) output.textContent = JSON.stringify(data, null, 2);
    const status = card?.querySelector('[data-role="calStatus"]');
    if (status) {
      status.textContent = 'Loaded';
      status.className = 'badge online';
    }
  } catch (error) {
    if (output) output.textContent = error.message;
  }
}

async function loadAllCalibration() {
  for (const gatewayId of visibleGatewayIds()) {
    await loadCalibration(gatewayId);
  }
}

async function saveCalibration(gatewayId) {
  const card = cardFor(gatewayId);
  const output = card?.querySelector('[data-role="calOutput"]');
  if (!field(card, 'routeComplete')?.checked) {
    if (output) output.textContent = 'Calibration not saved. Mark Destination reached only when the train has completed the start-to-destination run.';
    return;
  }
  if (!gatewayApiKey(gatewayId)) {
    if (output) output.textContent = `Enter the API key for ${gatewayLabel(gatewayId)} before saving calibration.`;
    return;
  }

  const payload = {
    leftWheelFactor: Number(field(card, 'leftWheelFactor').value),
    rightWheelFactor: Number(field(card, 'rightWheelFactor').value),
    adxlLeft: {
      x: Number(field(card, 'adxlLeftX').value),
      y: Number(field(card, 'adxlLeftY').value),
      z: Number(field(card, 'adxlLeftZ').value),
    },
    adxlRight: {
      x: Number(field(card, 'adxlRightX').value),
      y: Number(field(card, 'adxlRightY').value),
      z: Number(field(card, 'adxlRightZ').value),
    },
    bogie: { journeyComplete: true },
    encoder: {},
  };

  try {
    const data = await requestJson(`/api/v1/calibration/${encodeURIComponent(gatewayId)}`, {
      method: 'POST',
      headers: { ...gatewayHeaders(gatewayId), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (output) output.textContent = JSON.stringify(data, null, 2);
    const status = card?.querySelector('[data-role="calStatus"]');
    if (status) {
      status.textContent = 'Saved';
      status.className = 'badge online';
    }
  } catch (error) {
    if (output) output.textContent = error.message;
  }
}

async function loadDashboard(options = {}) {
  const trainNo = trainNoValue();
  if (!trainNo) {
    setStatus('Enter train number', 'error');
    renderGatewayCards(dashboardGatewayIds);
    return;
  }
  if (!options.silent) setStatus('Loading');
  try {
    const data = await requestJson(`/api/v1/trains/${encodeURIComponent(trainNo)}/dashboard`);
    const [rmsPoints, mapAlerts] = await Promise.all([
      requestJson(`/api/v1/map/rms?train_id=${encodeURIComponent(trainNo)}`).catch(() => []),
      requestJson(`/api/v1/map/alerts?train_id=${encodeURIComponent(trainNo)}`).catch(() => []),
    ]);
    data.rmsPoints = rmsPoints;
    data.mapAlerts = mapAlerts;
    state.rmsPoints = rmsPoints;
    state.mapAlerts = mapAlerts;
    renderDashboard(data);
    await renderTrainPosition(trainNo);
    rememberTrainNumber(data.train?.trainNo || trainNo);
    lastLoadedTrainNo = trainNo;
    startAutoRefresh();
    setStatus('Live', 'ok');
  } catch (error) {
    setStatus('Error', 'error');
    setHtml('gatewayList', `<p class="error-text">${error.message}</p>`);
  }
}

async function resetSession() {
  const trainNo = trainNoValue();
  if (!confirm(`Reset session for train ${trainNo}?`)) return;
  try {
    const data = await requestJson('/api/v1/sessions/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': $('adminKey')?.value.trim() || '' },
      body: JSON.stringify({ trainNo }),
    });
    setText('resetOutput', JSON.stringify(data, null, 2));
    setStatus('Reset', 'ok');
    await loadDashboard();
  } catch (error) {
    setStatus('Error', 'error');
    setText('resetOutput', error.message);
  }
}

function selectTab(tabId) {
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tabId));
  document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === tabId));
  if (tabId === 'alerts') {
    setTimeout(() => gatewayIds.forEach((gatewayId) => maps[gatewayId]?.invalidateSize()), 120);
  }
  if (tabId === 'logs') loadLogs();
  if (tabId === 'repeated_alarm') loadRepeatedAlarmReport();
  if (tabId === 'alarm_log_reports') loadAlarmLogReport();
}

function boot() {
  initializeMaps();
  buildCalibrationCards();
  updateGatewaySelector({});
  renderRecentTrainNumbers();
  setStatus('Live', 'ok');
  $('searchBtn')?.addEventListener('click', loadDashboard);
  $('dashboardGateway')?.addEventListener('change', () => {
    logClientEvent('gateway_filter_change', { message: selectedGatewayValue() || 'All Gateways' });
    if (state.dashboard) renderDashboard(state.dashboard);
    refreshVisibleMaps(180);
    if (lastLoadedTrainNo) renderTrainPosition(lastLoadedTrainNo);
  });
  $('trainNo')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') loadDashboard();
  });
  $('loadAllCalibrationBtn')?.addEventListener('click', loadAllCalibration);
  $('resetBtn')?.addEventListener('click', resetSession);
  $('cleanupBtn')?.addEventListener('click', cleanupData);
  $('loadLogsBtn')?.addEventListener('click', loadLogs);
  document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => {
    logClientEvent('tab_change', { message: button.dataset.tab });
    selectTab(button.dataset.tab);
  }));
  renderGatewayCards(dashboardGatewayIds);
  initializeReports();
  logBrowserLocation('dashboard_loaded');
}

window.addEventListener('error', (event) => {
  logClientEvent('javascript_error', { errorMessage: `${event.message} at ${event.filename}:${event.lineno}` });
});

window.addEventListener('unhandledrejection', (event) => {
  logClientEvent('promise_error', { errorMessage: String(event.reason?.message || event.reason || 'Unhandled promise rejection') });
});


// =====================================================================
// REPORTING MODULES IMPLEMENTATION
// =====================================================================
const APP_CONSTANTS = {
  DATE: {
    DEFAULT_DAYS_BACK: 60,
    MAX_RANGE_DAYS: 365
  },
  API: {
    CONTENT_TYPE_JSON: "application/json"
  },
  TABLE: {
    EMPTY_VALUE: "-"
  },
  ERROR_MESSAGES: {
    EXPORT_CSV_ERROR: "Failed to export CSV file.",
    EXPORT_EXCEL_ERROR: "Failed to export Excel file."
  }
};

globalThis.ApiClient = Object.freeze({
  async get(url) {
    const response = await fetch(url);
    return handleResponse(response);
  },
  async post(url, payload) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": APP_CONSTANTS.API.CONTENT_TYPE_JSON
      },
      body: JSON.stringify(payload)
    });
    return handleResponse(response);
  }
});

async function handleResponse(response) {
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }
  if (!response.ok) {
    const message = data?.detail || data?.message || "Server Error";
    throw new Error(message);
  }
  return data;
}

globalThis.DateUtils = Object.freeze({
  formatDateTimeLocal,
  formatDisplayDateTime,
  formatDisplayDate,
  initializeDefaultDates,
  applyDateRangeConstraints,
  validateDateRange
});

function initializeDefaultDates(fromId, toId) {
  const fromInput = $(fromId);
  const toInput = $(toId);
  if (!fromInput || !toInput) return;
  
  const now = new Date();
  const fromDate = new Date(now);
  fromDate.setDate(now.getDate() - APP_CONSTANTS.DATE.DEFAULT_DAYS_BACK);
  
  fromInput.value = formatDateTimeLocal(fromDate);
  toInput.value = formatDateTimeLocal(now);
}

function applyDateRangeConstraints(fromId, toId) {
  const fromInput = $(fromId);
  const toInput = $(toId);
  if (!fromInput || !toInput) return;
  
  const fromValue = fromInput.value;
  if (!fromValue) return;
  
  const fromDate = new Date(fromValue);
  const maxDate = new Date(fromDate);
  maxDate.setDate(maxDate.getDate() + APP_CONSTANTS.DATE.MAX_RANGE_DAYS);
  
  toInput.min = formatDateTimeLocal(fromDate);
  toInput.max = formatDateTimeLocal(maxDate);
  
  if (toInput.value && new Date(toInput.value) > maxDate) {
    toInput.value = formatDateTimeLocal(maxDate);
  }
}

function validateDateRange(fromId, toId) {
  const fromInput = $(fromId);
  const toInput = $(toId);
  if (!fromInput || !toInput) return false;
  
  const fromValue = fromInput.value;
  const toValue = toInput.value;
  if (!fromValue || !toValue) return false;
  
  const fromDate = new Date(fromValue);
  const toDate = new Date(toValue);
  const diffDays = (toDate - fromDate) / (1000 * 60 * 60 * 24);
  
  return toDate >= fromDate && diffDays <= APP_CONSTANTS.DATE.MAX_RANGE_DAYS;
}

function formatDateTimeLocal(date) {
  const offset = date.getTimezoneOffset();
  const localDate = new Date(date.getTime() - offset * 60000);
  return localDate.toISOString().slice(0, 16);
}

function formatDisplayDateTime(dateString) {
  if (!dateString) return "-";
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return dateString;
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${day}-${month}-${year} ${hours}:${minutes}:${seconds}`;
}

function formatDisplayDate(dateString) {
  if (!dateString) return "-";
  if (typeof dateString === 'string' && /^\d{2}-\d{2}-\d{4}$/.test(dateString)) {
    return dateString;
  }
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return dateString;
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

globalThis.ExportUtils = Object.freeze({
  downloadBlob(blob, fileName) {
    const url = globalThis.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    globalThis.URL.revokeObjectURL(url);
  },
  downloadCsv(csvContent, fileName) {
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    this.downloadBlob(blob, fileName);
  },
  extractFilename(response, fallbackName) {
    const disposition = response.headers.get("Content-Disposition");
    if (!disposition) return fallbackName;
    const match = /filename="?([^"]+)"?/.exec(disposition);
    return match?.[1] || fallbackName;
  },
  async downloadResponse(response, fallbackName) {
    const blob = await response.blob();
    const fileName = this.extractFilename(response, fallbackName);
    this.downloadBlob(blob, fileName);
  }
});

globalThis.TableSorter = (function () {
  function sort(records, options = {}) {
    const { direction = "asc", extractor } = options;
    if (!Array.isArray(records)) return [];
    if (typeof extractor !== "function") return [...records];
    return [...records].sort((left, right) => {
      const a = extractor(left);
      const b = extractor(right);
      return compareValues(a, b, direction);
    });
  }

  function compareValues(a, b, direction) {
    const nullResult = compareNulls(a, b);
    if (nullResult !== null) return nullResult;
    const type = detectType(a, b);
    let result = 0;
    switch (type) {
      case "number":
        result = Number(a) - Number(b);
        break;
      case "datetime":
        result = parseDateTime(a) - parseDateTime(b);
        break;
      case "date":
        result = parseDate(a) - parseDate(b);
        break;
      case "time":
        result = parseTime(a) - parseTime(b);
        break;
      default:
        result = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
    }
    return direction === "desc" ? result * -1 : result;
  }

  function compareNulls(a, b) {
    const emptyA = isEmpty(a);
    const emptyB = isEmpty(b);
    if (emptyA && emptyB) return 0;
    if (emptyA) return 1;
    if (emptyB) return -1;
    return null;
  }

  function isEmpty(value) {
    if (value == null) return true;
    const normalized = String(value).trim().toLowerCase();
    return (
      normalized === "" ||
      normalized === " " ||
      normalized === "-" ||
      normalized === "null" ||
      normalized === "n/a" ||
      normalized === "feedback not updated" ||
      normalized === "action not taken"
    );
  }

  function detectType(a, b) {
    const sample = a ?? b;
    if (sample == null) return "string";
    if (typeof sample === "number") return "number";
    const value = String(sample).trim();
    if (/^-?\d+(\.\d+)?$/.test(value)) return "number";
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return "datetime";
    if (/^\d{2}:\d{2}(:\d{2})?$/.test(value)) return "time";
    if (/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(value)) return "date";
    if (/^\d{2}[-/]\d{2}[-/]\d{4}\s+/.test(value)) return "datetime";
    return "string";
  }

  function parseDate(value) {
    const parts = value.replaceAll("/", "-").split("-");
    return new Date(parts[2], parts[1] - 1, parts[0]).getTime();
  }

  function parseTime(value) {
    const parts = value.split(":");
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2] || 0);
  }

  function parseDateTime(value) {
    if (value.includes("T")) return new Date(value).getTime();
    return new Date(value.replace(/^(\d{2})-(\d{2})-(\d{4})/, "$3-$2-$1")).getTime();
  }

  return { sort };
})();

globalThis.AlarmLogSort = (function () {
  let currentSort = {
    field: "alarmDate",
    direction: "desc",
  };
  return {
    getCurrentSort: () => currentSort,
    toggleSort: (field) => {
      if (currentSort.field === field) {
        currentSort.direction = currentSort.direction === "asc" ? "desc" : "asc";
      } else {
        currentSort.field = field;
        currentSort.direction = "asc";
      }
    },
    resetSort: () => {
      currentSort = { field: "alarmDate", direction: "desc" };
    },
    applySorting: (rows) => {
      const sort = currentSort;
      return TableSorter.sort(rows, {
        direction: sort.direction,
        extractor: (row) => row?.[sort.field]
      });
    }
  };
})();

globalThis.ValidationUtils = Object.freeze({
  isBlank: (value) => value == null || String(value).trim() === "",
  validateRequired(fields) {
    for (const [fieldName, value] of Object.entries(fields)) {
      if (this.isBlank(value)) {
        return { valid: false, message: `${fieldName} is required.` };
      }
    }
    return { valid: true, message: null };
  },
  validateRid(rid) {
    if (this.isBlank(rid)) {
      return { valid: false, message: "RID is required." };
    }
    return { valid: true, message: null };
  },
  validateDateRange(fromDateId, toDateId) {
    const valid = DateUtils.validateDateRange(fromDateId, toDateId);
    if (!valid) {
      return { valid: false, message: `Date range cannot exceed ${APP_CONSTANTS.DATE.MAX_RANGE_DAYS} days.` };
    }
    return { valid: true, message: null };
  }
});

let repeatedAlarmsData = [];
let allRows = [];
let currentRows = [];

async function loadRepeatedAlarmReport() {
  const fromDate = $('repFromDate').value;
  const toDate = $('repToDate').value;
  try {
    const data = await ApiClient.post('/api/reports/repeated-alarm/load', { fromDate, toDate });
    $('repTotalStocksCard').textContent = data.totalRollingStocks ?? 0;
    repeatedAlarmsData = data.rows || [];
    renderRepeatedAlarmsTable(repeatedAlarmsData);
  } catch (error) {
    alert("Repeated Alarm Load Error: " + error.message);
  }
}

function renderRepeatedAlarmsTable(rows) {
  const tbody = $('repeatedAlarmsTableBody');
  if (!tbody) return;
  const searchVal = $('repSearchRid').value.toLowerCase().trim();
  const filtered = rows.filter(r => !searchVal || r.rid.toLowerCase().includes(searchVal));
  
  tbody.innerHTML = filtered.length ? filtered.map(row => `
    <tr>
      <td><strong>${escapeHtml(row.rid)}</strong></td>
      <td>${row.count}</td>
      <td>
        <div style="position: relative; display: inline-block;">
          <button class="dropdown-action-btn" onclick="toggleRowDropdown(event, '${row.rid}')"><i class="bi bi-eye"></i> View <i class="bi bi-chevron-down"></i></button>
          <div class="export-menu" id="dropdown-${row.rid}" style="top: 28px; min-width: 120px;">
            <button onclick="openAlarmLogFor('${row.rid}')" style="font-size:12px; padding:8px 12px; font-weight:600; text-align:left;">Alarm Log</button>
          </div>
        </div>
      </td>
    </tr>
  `).join('') : '<tr><td colspan="3">No results found.</td></tr>';
}

function toggleRowDropdown(event, rid) {
  event.stopPropagation();
  document.querySelectorAll('.export-menu').forEach(el => {
    if (el.id !== `dropdown-${rid}`) el.classList.remove('show');
  });
  const dropdown = $(`dropdown-${rid}`);
  if (dropdown) dropdown.classList.toggle('show');
}

function openAlarmLogFor(rid) {
  $('ridInput').value = rid;
  $('fromDate').value = $('repFromDate').value;
  $('toDate').value = $('repToDate').value;
  selectTab('alarm_log_reports');
}

async function loadAlarmLogReport() {
  const request = {
    rid: $('ridInput').value.trim(),
    fromDate: $('fromDate').value,
    toDate: $('toDate').value,
    alarmType: $('alarmTypeFilter').value,
    feedbackStatus: $('feedbackStatusFilter').value
  };
  try {
    const data = await ApiClient.post('/api/reports/alarm-log/load', request);
    renderSummary(data.summary);
    renderCurrentResultSet();
    renderBanner(data);
    
    allRows = data.rows || [];
    currentRows = AlarmLogSort.applySorting([...allRows]);
    updateSortIndicators();
    renderTable(currentRows);
    
    $('summarySection').style.display = "block";
    $('tableSection').style.display = "block";
    $('exportToolbar').style.display = "block";
  } catch (error) {
    alert("Alarm Log Load Error: " + error.message);
  }
}

function renderSummary(summary) {
  $('totalRecordsCard').textContent = summary.totalRecords ?? 0;
  $('totalAlarmCard').textContent = summary.totalAlarmCount ?? 0;
  $('criticalAlarmCard').textContent = summary.criticalAlarmCount ?? 0;
  $('maintenanceAlarmCard').textContent = summary.maintenanceAlarmCount ?? 0;
  $('feedbackUpdatedCard').textContent = summary.feedbackUpdated ?? 0;
  $('feedbackPendingCard').textContent = summary.feedbackPending ?? 0;
}

function renderCurrentResultSet() {
  $('currentResultSection').style.display = "block";
  const rid = $('ridInput').value.trim() || "ALL";
  const alarmType = $('alarmTypeFilter').value || "ALL";
  const feedbackStatus = $('feedbackStatusFilter').value || "ALL";
  const fromDate = $('fromDate').value;
  const toDate = $('toDate').value;
  
  $('currentRid').textContent = rid;
  $('currentAlarmType').textContent = alarmType;
  $('currentFeedbackStatus').textContent = feedbackStatus;
  $('currentDateRange').textContent = `${DateUtils.formatDisplayDateTime(fromDate)} → ${DateUtils.formatDisplayDateTime(toDate)}`;
}

function renderBanner(data) {
  const banner = $('recordBanner');
  if (!banner) return;
  if (data.recordsTruncated) {
    banner.style.display = "block";
    banner.innerHTML = `Displaying first ${data.rows.length} records out of ${data.totalRecords} records. You may continue browsing these records or export the complete dataset using CSV or Excel.`;
  } else {
    banner.style.display = "none";
  }
}

function renderTable(rows) {
  const tbody = $('alarmLogTableBody');
  if (!tbody) return;
  tbody.innerHTML = rows.length ? rows.map(row => `
    <tr>
      <td>${DateUtils.formatDisplayDate(row.alarmDate)}</td>
      <td>${row.alarmTime}</td>
      <td>${escapeHtml(row.machineName)}</td>
      <td><strong>${escapeHtml(row.train)}</strong></td>
      <td>${escapeHtml(row.trainType)}</td>
      <td>${row.axleNo}</td>
      <td>${escapeHtml(row.rollingStockZoneCode)}</td>
      <td>${escapeHtml(row.rollingStockType)}</td>
      <td>${escapeHtml(row.rollingStockNumber)}</td>
      <td>${escapeHtml(row.enrouteDiagnosis)}</td>
      <td>${escapeHtml(row.enrouteActionTaken)}</td>
      <td>${escapeHtml(row.depotDiagnosis)}</td>
      <td>${row.maximumDynamicLoadLeft}</td>
      <td>${row.impactLoadFactorLeft}</td>
      <td>${row.maximumDynamicLoadRight}</td>
      <td>${row.impactLoadFactorRight}</td>
      <td>
        <button class="table-btn" onclick="showFeedbackModal('${row.id}', '${escapeHtml(row.enrouteDiagnosis)}', '${escapeHtml(row.enrouteActionTaken)}', '${escapeHtml(row.depotDiagnosis)}')">Feedback</button>
      </td>
    </tr>
  `).join('') : '<tr><td colspan="17">No results found.</td></tr>';
}

function refreshTable() {
  currentRows = [...allRows];
  currentRows = AlarmLogSort.applySorting(currentRows);
  renderTable(currentRows);
}

async function exportRepeatedAlarmCsv() {
  const payload = { fromDate: $('repFromDate').value, toDate: $('repToDate').value };
  try {
    const response = await fetch('/api/reports/repeated-alarm/export/csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    await ExportUtils.downloadResponse(response, "RepeatedAlarms.csv");
  } catch (error) {
    alert("Failed to export Repeated Alarms CSV.");
  }
}

async function exportRepeatedAlarmExcel() {
  const payload = { fromDate: $('repFromDate').value, toDate: $('repToDate').value };
  try {
    const response = await fetch('/api/reports/repeated-alarm/export/excel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    await ExportUtils.downloadResponse(response, "RepeatedAlarms.xls");
  } catch (error) {
    alert("Failed to export Repeated Alarms Excel.");
  }
}

async function exportCsv() {
  const payload = {
    rid: $('ridInput').value.trim(),
    fromDate: $('fromDate').value,
    toDate: $('toDate').value,
    alarmType: $('alarmTypeFilter').value,
    feedbackStatus: $('feedbackStatusFilter').value
  };
  try {
    const response = await fetch('/api/reports/alarm-log/export/csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    await ExportUtils.downloadResponse(response, "AlarmLog.csv");
  } catch (error) {
    alert("Failed to export Alarm Log CSV.");
  }
}

async function exportExcel() {
  const payload = {
    rid: $('ridInput').value.trim(),
    fromDate: $('fromDate').value,
    toDate: $('toDate').value,
    alarmType: $('alarmTypeFilter').value,
    feedbackStatus: $('feedbackStatusFilter').value
  };
  try {
    const response = await fetch('/api/reports/alarm-log/export/excel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    await ExportUtils.downloadResponse(response, "AlarmLog.xls");
  } catch (error) {
    alert("Failed to export Alarm Log Excel.");
  }
}

function showFeedbackModal(alertId, enrouteDiagnosis, enrouteAction, depotDiagnosis) {
  $('feedbackAlertId').value = alertId;
  $('feedbackEnrouteDiagnosis').value = enrouteDiagnosis === 'Feedback Not Updated' ? '' : enrouteDiagnosis;
  $('feedbackEnrouteAction').value = enrouteAction === 'Action Not Taken' ? '' : enrouteAction;
  $('feedbackDepotDiagnosis').value = depotDiagnosis === 'Feedback Not Updated' ? '' : depotDiagnosis;
  $('feedbackModal').classList.remove('hidden');
}

function closeFeedbackModal() {
  $('feedbackModal').classList.add('hidden');
}

async function submitFeedback() {
  const alertId = $('feedbackAlertId').value;
  const payload = {
    enrouteDiagnosis: $('feedbackEnrouteDiagnosis').value.trim() || 'Feedback Not Updated',
    enrouteAction: $('feedbackEnrouteAction').value.trim() || 'Action Not Taken',
    depotDiagnosis: $('feedbackDepotDiagnosis').value.trim() || 'Feedback Not Updated'
  };
  try {
    await ApiClient.post(`/api/reports/alerts/${alertId}/feedback`, payload);
    closeFeedbackModal();
    loadAlarmLogReport();
  } catch (error) {
    alert("Failed to update feedback: " + error.message);
  }
}

function initializeTableSorting() {
  document.querySelectorAll("#alarmLogTable th[data-field]").forEach((header) => {
    header.classList.add("sortable-header");
    header.addEventListener("click", () => {
      const field = header.dataset.field;
      AlarmLogSort.toggleSort(field);
      updateSortIndicators();
      refreshTable();
    });
  });
}

function updateSortIndicators() {
  document.querySelectorAll("#alarmLogTable th[data-field]").forEach((header) => {
    header.classList.remove("sort-asc", "sort-desc");
  });
  const sort = AlarmLogSort.getCurrentSort();
  const activeHeader = document.querySelector(`#alarmLogTable th[data-field="${sort.field}"]`);
  if (activeHeader) {
    activeHeader.classList.add(sort.direction === "asc" ? "sort-asc" : "sort-desc");
  }
}

function initializeReports() {
  DateUtils.initializeDefaultDates("repFromDate", "repToDate");
  DateUtils.initializeDefaultDates("fromDate", "toDate");
  
  DateUtils.applyDateRangeConstraints("repFromDate", "repToDate");
  DateUtils.applyDateRangeConstraints("fromDate", "toDate");
  
  $('repFromDate')?.addEventListener("change", () => DateUtils.applyDateRangeConstraints("repFromDate", "repToDate"));
  $('repToDate')?.addEventListener("change", () => DateUtils.applyDateRangeConstraints("repFromDate", "repToDate"));
  $('fromDate')?.addEventListener("change", () => DateUtils.applyDateRangeConstraints("fromDate", "toDate"));
  $('toDate')?.addEventListener("change", () => DateUtils.applyDateRangeConstraints("fromDate", "toDate"));
  
  $('repLoadReportBtn')?.addEventListener("click", loadRepeatedAlarmReport);
  $('loadReportBtn')?.addEventListener("click", loadAlarmLogReport);
  
  $('repSearchRid')?.addEventListener("input", () => renderRepeatedAlarmsTable(repeatedAlarmsData));
  
  $('repExportBtn')?.addEventListener("click", (event) => {
    event.stopPropagation();
    $('repExportMenu').classList.toggle('show');
  });
  
  const alarmLogExportBtn = document.querySelector('#exportToolbar .export-btn');
  const alarmLogExportMenu = document.querySelector('#exportToolbar .export-menu');
  alarmLogExportBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    alarmLogExportMenu?.classList.toggle('show');
  });
  
  document.addEventListener("click", () => {
    $('repExportMenu')?.classList.remove('show');
    alarmLogExportMenu?.classList.remove('show');
    document.querySelectorAll('.export-menu').forEach(el => {
      if (!el.id.startsWith('repExport') && !el.closest('#exportToolbar')) el.classList.remove('show');
    });
  });
  
  $('repExportCsvBtn')?.addEventListener("click", exportRepeatedAlarmCsv);
  $('repExportExcelBtn')?.addEventListener("click", exportRepeatedAlarmExcel);
  $('exportCsvBtn')?.addEventListener("click", exportCsv);
  $('exportExcelBtn')?.addEventListener("click", exportExcel);
  
  $('closeFeedbackModalBtn')?.addEventListener("click", closeFeedbackModal);
  $('submitFeedbackBtn')?.addEventListener("click", submitFeedback);
  
  initializeTableSorting();
}

window.openAlarmLogFor = openAlarmLogFor;
window.toggleRowDropdown = toggleRowDropdown;
window.showFeedbackModal = showFeedbackModal;


boot();
