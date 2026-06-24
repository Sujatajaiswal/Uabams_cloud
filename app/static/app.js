const state = { dashboard: null };
const gatewayIds = ['GW_UABAMS_BOGIE_01', 'GW_UABAMS_BOGIE_02'];
const gatewayLabels = { GW_UABAMS_BOGIE_01: 'GW1', GW_UABAMS_BOGIE_02: 'GW2' };
const maps = {};
const layers = {};
const overlays = {};

const $ = (id) => document.getElementById(id);

function setStatus(text, mode = '') {
  const el = $('apiStatus');
  el.textContent = text;
  el.className = `status-pill ${mode}`.trim();
}

function apiKeyFor(gatewayId) {
  return gatewayId === 'GW_UABAMS_BOGIE_02' ? $('apiKeyGw2').value.trim() : $('apiKeyGw1').value.trim();
}

function gatewayHeaders(gatewayId) {
  return {
    'X-Gateway-Id': gatewayId,
    'X-Train-Id': $('trainNo').value.trim(),
    'X-Api-Key': apiKeyFor(gatewayId),
  };
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

function shortHash(value) {
  return value ? `${value.slice(0, 12)}...${value.slice(-8)}` : '-';
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
  if (!window.ol) {
    gatewayIds.forEach((id) => {
      const target = id === 'GW_UABAMS_BOGIE_02' ? 'mapGw2' : 'mapGw1';
      $(target).innerHTML = '<div class="empty-state">OpenLayers failed to load</div>';
    });
    return;
  }

  const config = [
    { gatewayId: 'GW_UABAMS_BOGIE_01', target: 'mapGw1', popup: 'popupGw1' },
    { gatewayId: 'GW_UABAMS_BOGIE_02', target: 'mapGw2', popup: 'popupGw2' },
  ];

  config.forEach(({ gatewayId, target, popup }) => {
    maps[gatewayId] = new ol.Map({
      target,
      layers: [new ol.layer.Tile({ source: new ol.source.OSM() })],
      view: new ol.View({ center: ol.proj.fromLonLat([78.9629, 20.5937]), zoom: 5 }),
    });

    overlays[gatewayId] = new ol.Overlay({
      element: $(popup),
      positioning: 'bottom-center',
      stopEvent: false,
      offset: [0, -12],
    });
    maps[gatewayId].addOverlay(overlays[gatewayId]);
    maps[gatewayId].on('click', (event) => showMapPopup(gatewayId, event));
  });
}

function showMapPopup(gatewayId, event) {
  const popupId = gatewayId === 'GW_UABAMS_BOGIE_02' ? 'popupGw2' : 'popupGw1';
  const popup = $(popupId);
  const feature = maps[gatewayId].forEachFeatureAtPixel(event.pixel, (item) => item);
  if (!feature) {
    popup.style.display = 'none';
    return;
  }
  popup.innerHTML = `<strong>${feature.get('alertType')}</strong><br>${gatewayLabels[gatewayId]}<br>Peak: ${feature.get('peakG')} G`;
  popup.style.display = 'block';
  overlays[gatewayId].setPosition(feature.getGeometry().getCoordinates());
}

function renderDashboard(data) {
  state.dashboard = data;
  const train = data.train || {};
  const gateways = data.gateways || [];
  const alerts = data.lastAlerts || [];
  const archives = data.archives || [];
  const activeSession = data.activeSession;
  const onlineCount = gateways.filter((gw) => gw.online).length;
  const criticalCount = alerts.filter((alert) => alert.alert === 'RED').length;
  const gw1Alert = latestAlertFor(alerts, 'GW_UABAMS_BOGIE_01');
  const gw2Alert = latestAlertFor(alerts, 'GW_UABAMS_BOGIE_02');
  const samePeak = gw1Alert && gw2Alert && gw1Alert.peakValueG === gw2Alert.peakValueG;

  $('heroTrain').textContent = train.trainNo || $('trainNo').value.trim();
  $('summaryTrain').textContent = train.trainNo || '-';
  $('summaryStatus').textContent = train.status || '-';
  $('summaryGateways').textContent = `${onlineCount}/${gateways.length || 2}`;
  $('summaryLastData').textContent = formatDate(lastDataTime(train, gateways, alerts, archives));
  $('summaryCompare').textContent = samePeak ? `Common ${gw1Alert.peakValueG} G` : 'GW values differ';
  $('summaryArchives').textContent = archives.length;
  $('summaryCritical').textContent = criticalCount;
  $('summaryPeak').textContent = alerts[0] ? `${alerts[0].peakValueG} G` : '-';

  $('gatewayList').innerHTML = gatewayIds.map((gatewayId) => {
    const gw = gateways.find((item) => item.gatewayId === gatewayId) || { gatewayId, trainId: train.trainNo, online: false };
    const latest = latestAlertFor(alerts, gatewayId);
    const statusClass = gw.online ? 'online-box' : 'offline-box';
    return `
      <article class="gateway-card ${statusClass}">
        <div class="gateway-title">
          <span>${gatewayLabels[gatewayId]} - ${gatewayId}</span>
          <span class="badge ${gw.online ? 'online' : 'offline'}">${gw.online ? 'Online' : 'Offline'}</span>
        </div>
        <div class="gateway-kpis">
          <div><span>Train</span><strong>${gw.trainId || train.trainNo || '-'}</strong></div>
          <div><span>Latest Peak</span><strong>${latest ? `${latest.peakValueG} G` : '-'}</strong></div>
          <div><span>Alert</span><strong>${latest ? latest.alert : '-'}</strong></div>
          <div><span>Archives</span><strong>${archiveCountFor(archives, gatewayId)}</strong></div>
        </div>
        <div>Last heartbeat: ${formatDate(gw.lastHeartbeat)}</div>
        <div>Last alert location: ${latest ? `${latest.latitude}, ${latest.longitude}` : '-'}</div>
      </article>
    `;
  }).join('');

  renderAlerts(alerts);
  renderMaps(alerts, gateways);
  renderArchives(archives);
  renderSession(activeSession, train.trainNo);
}

function renderAlerts(alerts) {
  $('alertsTable').innerHTML = alerts.length ? alerts.map((alert) => `
    <tr>
      <td>${formatDate(alert.createdAt)}</td>
      <td>${alert.gatewayId || '-'}</td>
      <td>${alert.peakValueG ?? '-'}</td>
      <td><span class="badge ${alert.alert}">${alert.alert || '-'}</span></td>
      <td>${alert.latitude ?? '-'}, ${alert.longitude ?? '-'}</td>
    </tr>
  `).join('') : '<tr><td colspan="5">No alerts found.</td></tr>';
}

function renderMaps(alerts, gateways) {
  gatewayIds.forEach((gatewayId) => {
    const map = maps[gatewayId];
    if (!map || !window.ol) return;
    if (layers[gatewayId]) map.removeLayer(layers[gatewayId]);

    const gatewayAlerts = alerts.filter((alert) => alert.gatewayId === gatewayId && Number.isFinite(Number(alert.latitude)) && Number.isFinite(Number(alert.longitude)));
    const features = gatewayAlerts.map((alert) => new ol.Feature({
      geometry: new ol.geom.Point(ol.proj.fromLonLat([Number(alert.longitude), Number(alert.latitude)])),
      peakG: alert.peakValueG,
      alertType: alert.alert,
      gatewayId: alert.gatewayId,
    }));

    layers[gatewayId] = new ol.layer.Vector({
      source: new ol.source.Vector({ features }),
      style: (feature) => new ol.style.Style({
        image: new ol.style.Circle({
          radius: 8,
          fill: new ol.style.Fill({ color: alertColor(feature.get('alertType')) }),
          stroke: new ol.style.Stroke({ color: 'white', width: 2 }),
        }),
      }),
    });
    map.addLayer(layers[gatewayId]);

    const gw = gateways.find((item) => item.gatewayId === gatewayId);
    const stateId = gatewayId === 'GW_UABAMS_BOGIE_02' ? 'gw2MapState' : 'gw1MapState';
    $(stateId).textContent = gw?.online ? 'Online' : 'Offline';
    $(stateId).className = `badge ${gw?.online ? 'online' : 'offline'}`;

    if (features.length) {
      map.getView().fit(layers[gatewayId].getSource().getExtent(), { padding: [40, 40, 40, 40], maxZoom: 13, duration: 250 });
    }
  });
}

function renderArchives(archives) {
  $('archiveTable').innerHTML = archives.length ? archives.map((archive) => `
    <tr>
      <td>${formatDate(archive.receivedAt)}</td>
      <td>${archive.gatewayId || '-'}</td>
      <td>${bytes(archive.sizeBytes)}</td>
      <td><code>${shortHash(archive.sha256)}</code></td>
      <td>${archive.status || '-'}</td>
    </tr>
  `).join('') : '<tr><td colspan="5">No archives uploaded.</td></tr>';
}

function renderSession(session, trainNo) {
  $('sessionText').textContent = session
    ? `Active session ${session.sessionId} for train ${trainNo}.`
    : `No active session for train ${trainNo || '-'}.`;
}

function calibrationCard(gatewayId) {
  const label = gatewayLabels[gatewayId];
  return `
    <article class="calibration-card" data-gateway="${gatewayId}">
      <div class="gateway-title">
        <span>${label} Calibration</span>
        <span class="badge offline" data-role="calStatus">Pending</span>
      </div>
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
  $('calibrationPair').innerHTML = gatewayIds.map(calibrationCard).join('');
  $('calibrationPair').addEventListener('click', async (event) => {
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
  return card.querySelector(`[data-field="${name}"]`);
}

function setCalibrationValues(gatewayId, data) {
  const card = cardFor(gatewayId);
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
  const output = card.querySelector('[data-role="calOutput"]');
  try {
    const data = await requestJson(`/api/v1/calibration/${encodeURIComponent(gatewayId)}`, { headers: gatewayHeaders(gatewayId) });
    setCalibrationValues(gatewayId, data);
    output.textContent = JSON.stringify(data, null, 2);
    card.querySelector('[data-role="calStatus"]').textContent = 'Loaded';
    card.querySelector('[data-role="calStatus"]').className = 'badge online';
  } catch (error) {
    output.textContent = error.message;
  }
}

async function loadAllCalibration() {
  for (const gatewayId of gatewayIds) {
    await loadCalibration(gatewayId);
  }
}

async function saveCalibration(gatewayId) {
  const card = cardFor(gatewayId);
  const output = card.querySelector('[data-role="calOutput"]');
  if (!field(card, 'routeComplete').checked) {
    output.textContent = 'Calibration not saved. Mark Destination reached only when the train has completed the start-to-destination run.';
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
    output.textContent = JSON.stringify(data, null, 2);
    card.querySelector('[data-role="calStatus"]').textContent = 'Saved';
    card.querySelector('[data-role="calStatus"]').className = 'badge online';
  } catch (error) {
    output.textContent = error.message;
  }
}

async function loadDashboard() {
  const trainNo = $('trainNo').value.trim();
  if (!trainNo) return;
  setStatus('Loading');
  try {
    const data = await requestJson(`/api/v1/trains/${encodeURIComponent(trainNo)}/dashboard`);
    renderDashboard(data);
    setStatus('Live', 'ok');
  } catch (error) {
    setStatus('Error', 'error');
    $('gatewayList').innerHTML = `<p class="error-text">${error.message}</p>`;
  }
}

async function resetSession() {
  const trainNo = $('trainNo').value.trim();
  if (!confirm(`Reset session for train ${trainNo}?`)) return;
  try {
    const data = await requestJson('/api/v1/sessions/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': $('adminKey').value.trim() },
      body: JSON.stringify({ trainNo }),
    });
    $('resetOutput').textContent = JSON.stringify(data, null, 2);
    setStatus('Reset', 'ok');
    await loadDashboard();
  } catch (error) {
    setStatus('Error', 'error');
    $('resetOutput').textContent = error.message;
  }
}

function selectTab(tabId) {
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tabId));
  document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === tabId));
  if (tabId === 'alerts') {
    setTimeout(() => gatewayIds.forEach((gatewayId) => maps[gatewayId]?.updateSize()), 80);
  }
}

function boot() {
  initializeMaps();
  buildCalibrationCards();
  $('searchBtn').addEventListener('click', loadDashboard);
  $('loadAllCalibrationBtn').addEventListener('click', loadAllCalibration);
  $('resetBtn').addEventListener('click', resetSession);
  document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => selectTab(button.dataset.tab)));
  loadDashboard();
}

boot();
