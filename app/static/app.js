const state = { dashboard: null, rmsPoints: [], mapAlerts: [], selectedGateway: '' };
const defaultGatewayIds = ['GW_UABAMS_BOGIE_01', 'GW_UABAMS_BOGIE_02'];
const gatewayIds = defaultGatewayIds;
let dashboardGatewayIds = [...defaultGatewayIds];
const maps = {};
const layers = {};

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
          <div><span>Train</span><strong>${gw.trainId || train.trainNo || '-'}</strong></div>
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
      }
    ).addTo(layer);
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
      .filter((point) => normalizeAlert(point.color) === 'RED')
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
      L.circleMarker(markerPoint, {
        radius: 13,
        color: '#111827',
        weight: 2,
        fillColor: alertColor('RED'),
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
    setStatus('Loading');
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

async function loadDashboard() {
  const trainNo = trainNoValue();
  if (!trainNo) {
    setStatus('Enter train number', 'error');
    setHtml('gatewayList', '<p class="empty-state">Enter a train number and select Search Train.</p>');
    return;
  }
  setStatus('Loading');
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
}

function boot() {
  initializeMaps();
  buildCalibrationCards();
  updateGatewaySelector({});
  setStatus('Live', 'ok');
  $('searchBtn')?.addEventListener('click', loadDashboard);
  $('dashboardGateway')?.addEventListener('change', () => {
    if (state.dashboard) renderDashboard(state.dashboard);
  });
  $('trainNo')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') loadDashboard();
  });
  $('loadAllCalibrationBtn')?.addEventListener('click', loadAllCalibration);
  $('resetBtn')?.addEventListener('click', resetSession);
  $('cleanupBtn')?.addEventListener('click', cleanupData);
  document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => selectTab(button.dataset.tab)));
  setHtml('gatewayList', '<p class="empty-state">Enter a train number and select Search Train.</p>');
}

boot();
