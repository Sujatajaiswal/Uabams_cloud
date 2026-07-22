const state = { dashboard: null, rmsPoints: [], mapAlerts: [], selectedGateway: '', selectedDateFilter: null };
const defaultGatewayIds = ['GW_UABAMS_BOGIE_01', 'GW_UABAMS_BOGIE_02'];
const gatewayIds = defaultGatewayIds;
let dashboardGatewayIds = [...defaultGatewayIds];
const maps = {};
const layers = {};
const trainMarkers = {};
let autoRefreshTimer = null;
let lastLoadedTrainNo = "";
const recentTrainStorageKey = 'uabams_recent_train_numbers';
let chartXInstance = null;
let chartYInstance = null;
let chartZInstance = null;

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
  let rawVal = $('trainNo')?.value.trim() || '';
  if (rawVal.includes(' - ')) {
    rawVal = rawVal.split(' - ')[0].trim();
  }
  if (/^\d{3}$/.test(rawVal)) {
    return 'TR_' + rawVal;
  }
  return rawVal;
}


function recentTrainNumbers() {
  try {
    const values = JSON.parse(localStorage.getItem(recentTrainStorageKey) || '[]');
    if (!Array.isArray(values)) return [];
    return values.map(val => {
      let no = '';
      if (typeof val === 'object' && val !== null) {
        no = val.trainNo || '';
      } else {
        no = String(val || '');
      }
      if (no.startsWith('TR_')) {
        no = no.replace('TR_', '');
      }
      return no;
    })
    .filter(val => val && val !== 'object Object' && val !== '[object Object]');
  } catch {
    return [];
  }
}

function renderRecentTrainNumbers() {
  const list = $('recentTrainNos');
  const input = $('trainNo');

  if (!list || !input) return;

  if (!input.dataset.hasDatalistFix) {
    input.dataset.hasDatalistFix = 'true';
    let tempVal = '';
    
    const onFocus = function() {
      tempVal = this.value;
      this.value = '';
    };
    
    const onBlur = function() {
      setTimeout(() => {
        if (this.value === '') {
          this.value = tempVal;
        }
      }, 200);
    };
    
    input.addEventListener('focus', onFocus);
    input.addEventListener('click', onFocus);
    input.addEventListener('blur', onBlur);
  }

  const localTrainNos = recentTrainNumbers();
  
  const renderList = (trainObjects) => {
    list.innerHTML = trainObjects
      .map((t) => {
        const no = (typeof t === 'object' && t !== null) ? (t.trainNo || '') : String(t);
        const name = (typeof t === 'object' && t !== null) ? (t.trainName || '') : '';
        
        if (no === '[object Object]' || no === 'object Object' || !no) return '';
        
        const label = name ? `${no} - ${name}` : no;
        return `<option value="${escapeHtml(label)}"></option>`;
      })
      .join('');
  };

  if (!input.value) {
    if (localTrainNos.length > 0) {
      input.value = localTrainNos[0];
    } else {
      input.value = '019456';
    }
  }

  fetch('/api/v1/trains')
    .then((res) => res.json())
    .then((serverTrains) => {
      if (Array.isArray(serverTrains)) {
        const standardizedServerTrains = serverTrains.map(t => {
          if (typeof t === 'object' && t !== null) {
            return t;
          }
          const no = String(t);
          let name = 'Express Train';
          if (no === '019456') {
            name = 'Gatimaan Express';
          } else if (no.startsWith('TR_')) {
            try {
              const num = parseInt(no.split('_')[1], 10);
              const names_pool = [
                "Rajdhani Express", "Shatabdi Express", "Duronto Express", 
                "Garib Rath", "HumSafar Express", "Vande Bharat Express", 
                "Tejas Express", "Jan Shatabdi", "Sampark Kranti", "Superfast Mail"
              ];
              name = names_pool[num % names_pool.length];
            } catch (e) {}
          }
          return { trainNo: no, trainName: name };
        });

        const map = new Map();
        localTrainNos.forEach(no => map.set(no, { trainNo: no, trainName: '' }));
        standardizedServerTrains.forEach(t => map.set(t.trainNo, t));
        const combined = Array.from(map.values());
        
        combined.forEach(item => {
          if (!item.trainName) {
            const serverMatch = standardizedServerTrains.find(s => s.trainNo === item.trainNo);
            if (serverMatch) item.trainName = serverMatch.trainName;
          }
        });
        
        renderList(combined);
      }
    })
    .catch((err) => console.error('Failed to load train list:', err));
}

function rememberTrainNumber(trainNo) {
  const cleanTrainNo = String(trainNo || '').trim();
  if (!cleanTrainNo) return;

  const currentRecents = recentTrainNumbers();
  const updated = [cleanTrainNo, ...currentRecents.filter(x => x !== cleanTrainNo)].slice(0, 10);

  localStorage.setItem(recentTrainStorageKey, JSON.stringify(updated));
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
  if (!index) return [Number(lat), Number(lon)];
  const angle = (index * 2 * Math.PI) / 8;
  const offset = 0.00015 * index;
  return [Number(lat) + offset * Math.sin(angle), Number(lon) + offset * Math.cos(angle)];
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
  const userRole = data.userRole || 'operator';
  const internalTabs = ['calibration', 'archives', 'reset', 'logs'];
  
  const swaggerBtn = document.getElementById('swaggerBtn') || document.querySelector('a[href="/docs"]');
  if (swaggerBtn) {
    swaggerBtn.style.display = (userRole === 'admin') ? '' : 'none';
  }

  document.querySelectorAll('.tab').forEach((button) => {
    const tabId = button.dataset.tab;
    if (internalTabs.includes(tabId)) {
      if (userRole === 'admin') {
        button.style.display = '';
      } else {
        button.style.display = 'none';
      }
    }
  });

  const activeTabBtn = document.querySelector('.tab.active');
  const activeTabId = activeTabBtn ? activeTabBtn.dataset.tab : '';
  if (userRole !== 'admin' && internalTabs.includes(activeTabId)) {
    selectTab('overview');
  }

  state.dashboard = data;
  updateGatewaySelector(data);
  const selectedGateway = selectedGatewayValue();
  state.selectedGateway = selectedGateway;
  const train = data.train || {};
  const gateways = data.gateways || [];
  let alerts = data.lastAlerts || [];
  const archives = data.archives || [];
  const activeSession = data.activeSession;
  const rmsPoints = data.rmsPoints || [];
  let mapAlerts = data.mapAlerts || alerts.map(dashboardAlertToMapPoint);

  if (state.selectedDateFilter) {
    alerts = alerts.filter(item => getItemDateStr(item) === state.selectedDateFilter);
    mapAlerts = mapAlerts.filter(item => getItemDateStr(item) === state.selectedDateFilter);
  }

  const allGatewayIds = dashboardGatewayIds;
  const viewGatewayIds = visibleGatewayIds();
  const allGateways = gateways.filter((gw) => allGatewayIds.includes(gw.gatewayId));
  const viewAlerts = alerts.filter((alert) => gatewayMatches(alert, selectedGateway));
  const viewArchives = archives.filter((archive) => gatewayMatches(archive, selectedGateway));
  const viewRmsPoints = rmsPoints.filter((point) => gatewayMatches(point, selectedGateway));
  const viewMapAlerts = mapAlerts.filter((point) => gatewayMatches(point, selectedGateway));
  const onlineCount = allGatewayIds.filter((gatewayId) => gateways.find((gw) => gw.gatewayId === gatewayId)?.online).length;
  const criticalCount = alerts.filter((alert) => alert.alert === 'RED').length;
  const trainDisplayName = train.trainName 
    ? `${train.trainNo} - ${train.trainName}`
    : train.trainNo || '-';
  setText('summaryTrain', trainDisplayName);
  let latestTripStr = '-';
  if (state.selectedTrip) {
    latestTripStr = `${state.selectedTrip.startTimeStr}<br>to<br>${state.selectedTrip.endTimeStr}`;
  } else if (archives && archives.length > 0) {
    const latestArch = archives[0];
    const endTimeVal = new Date(latestArch.receivedAt);
    const startTimeVal = new Date(endTimeVal.getTime() - 60 * 60 * 1000);
    latestTripStr = `${formatDate(startTimeVal)}<br>to<br>${formatDate(endTimeVal)}`;
  }
  setHtml('summaryLatestTrip', latestTripStr);
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
    
    const gatewayAlerts = alerts.filter((a) => a.gatewayId === gatewayId);
    const severityCount = latest ? gatewayAlerts.filter((a) => normalizeAlert(a.alert) === alertStatus).length : 0;
    const alertDisplay = latest ? `${alertStatus} (${severityCount})` : '-';
    
    return `
      <article class="gateway-card ${statusClass}">
        <div class="gateway-title">
          <span>${gatewayLabel(gatewayId)} - ${gatewayId}</span>
          <span class="badge ${gw.online ? 'online' : 'offline'}">${gw.online ? 'Online' : 'Offline'}</span>
        </div>
        <div class="gateway-kpis">
          <div><span>Train</span><strong>${train.trainNo || gw.trainId || '-'}</strong></div>
          <div><span>Latest Peak</span><strong>${latest ? `${latest.peakValueG} G` : '-'}</strong></div>
          <div class="alert-kpi ${latest ? alertStatus : ''}"><span>Alert</span><strong>${alertDisplay}</strong></div>
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

function getItemDateStr(item) {
  if (!item) return null;
  const rawDate = item.createdAt || item.created_at || item.receivedAt || item.received_at;
  if (!rawDate) return null;
  try {
    const parts = String(rawDate).split('T');
    const datePart = parts[0];
    if (datePart.match(/^\d{4}-\d{2}-\d{2}$/)) {
      return datePart;
    }
  } catch (e) {}
  
  try {
    const d = new Date(rawDate);
    if (!isNaN(d.getTime())) {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  } catch (e) {}
  return null;
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
  return `
    <div style="background: #ffffff; border: 2.5px solid #1d70b8; border-radius: 50%; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; box-shadow: 0 3px 8px rgba(0,0,0,0.35); transform: rotate(${rotation}deg); transition: transform 0.2s ease;">
      <i class="bi bi-train-front-fill" style="font-size: 20px; color: #1d70b8; display: block; line-height: 1;"></i>
    </div>
  `;
}

function drawColoredRoute(layer, points) {
  if (!layer || points.length < 2) return;

  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    const severity = normalizeAlert(current.color);
    L.polyline(
      [[Number(previous.lat), Number(previous.lon)], [Number(current.lat), Number(current.lon)]],
      {
        color: alertColor(severity),
        weight: 6,
        opacity: 0.9,
        lineCap: 'round',
        lineJoin: 'round',
        smoothFactor: 1.2,
        className: 'route-line',
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
      const severity = normalizeAlert(point.color);
      if (severity !== 'RED') return;
      const markerPoint = jitterPoint(point.lat, point.lon, index);
      L.circleMarker(markerPoint, {
        radius: 8,
        color: '#ffffff',
        weight: 2.5,
        fillColor: '#c24134',
        fillOpacity: 1,
      })
        .addTo(layer)
        .bindPopup(routePopup(point));
    });

    const redAlertPoints = alertPoints.filter(point => normalizeAlert(point.color) === 'RED');
    const bounds = L.latLngBounds([
      ...routePoints.map((point) => [Number(point.lat), Number(point.lon)]),
      ...redAlertPoints.map((point, index) => jitterPoint(point.lat, point.lon, index)),
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
        iconSize: [34, 34],
        iconAnchor: [17, 17],
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
    
    const getLogSeverity = (log) => {
      const act = String(log.action || '').toLowerCase();
      const err = String(log.errorMessage || '').toLowerCase();
      if (err && err !== '-' && err !== 'none' && err !== 'null') {
        return 'CRITICAL';
      }
      if (act.includes('delete') || act.includes('remove') || act.includes('reset') || act.includes('failed') || act.includes('unauthorized')) {
        return 'CRITICAL';
      }
      if (act.includes('login') || act.includes('logout') || act.includes('calibrate') || act.includes('export')) {
        return 'WARNING';
      }
      return 'NORMAL';
    };

    setHtml('logsTable', rows.length ? rows.map((log) => {
      const severity = getLogSeverity(log);
      let badgeStyle = '';
      if (severity === 'CRITICAL') {
        badgeStyle = 'background: rgba(239, 68, 68, 0.12); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.35);';
      } else if (severity === 'WARNING') {
        badgeStyle = 'background: rgba(245, 158, 11, 0.12); color: #fde047; border: 1px solid rgba(245, 158, 11, 0.35);';
      } else {
        badgeStyle = 'background: rgba(16, 185, 129, 0.12); color: #a7f3d0; border: 1px solid rgba(16, 185, 129, 0.35);';
      }
      
      const badgeHtml = `<span style="padding: 3px 8px; border-radius: 4px; font-size: 10px; font-weight: bold; display: inline-block; text-transform: uppercase; ${badgeStyle}">${severity}</span>`;
      
      const errHtml = log.errorMessage && log.errorMessage !== '-' ? `
        <span style="color: #ef4444; font-weight: bold;">${escapeHtml(log.errorMessage)}</span>
      ` : '-';

      return `
        <tr>
          <td>${formatDate(log.createdAt)}</td>
          <td>${escapeHtml(log.username || '-')}</td>
          <td>${escapeHtml(log.page || '-')}</td>
          <td>${escapeHtml(log.action || '-')}</td>
          <td>${badgeHtml}</td>
          <td>${errHtml}</td>
          <td>${escapeHtml(log.ipAddress || '-')}</td>
          <td>${log.latitude && log.longitude ? `${log.latitude}, ${log.longitude}` : '-'}</td>
        </tr>
      `;
    }).join('') : '<tr><td colspan="8">No logs found.</td></tr>');
  } catch (error) {
    setHtml('logsTable', `<tr><td colspan="8" class="error-text">${escapeHtml(error.message)}</td></tr>`);
  }
}

window.viewTripOnDashboard = function(startTimeStr, endTimeStr) {
  state.selectedTrip = { startTimeStr, endTimeStr };
  selectTab('overview');
  setHtml('summaryLatestTrip', `${startTimeStr}<br>to<br>${endTimeStr}`);
};

function renderArchives(archives) {
  setHtml('archiveTable', archives.length ? archives.map((archive) => {
    const endTimeVal = new Date(archive.receivedAt);
    const startTimeVal = new Date(endTimeVal.getTime() - 60 * 60 * 1000);
    const startTimeStr = formatDate(startTimeVal);
    const endTimeStr = formatDate(endTimeVal);
    const alertCount = archive.peakAlertCount ?? archive.faultRecordCount ?? 0;
    
    return `
      <tr onclick="viewTripOnDashboard('${startTimeStr}', '${endTimeStr}')" style="cursor: pointer;" class="clickable-row">
        <td>${startTimeStr}</td>
        <td>${endTimeStr}</td>
        <td>${bytes(archive.sizeBytes)}</td>
        <td>${archive.rmsRecordCount ?? 0}</td>
        <td>${archive.peakRecordCount ?? 0}</td>
        <td>${alertCount}</td>
        <td>${archive.status || '-'}</td>
      </tr>
    `;
  }).join('') : '<tr><td colspan="7">No archives uploaded.</td></tr>');
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
  if (lastLoadedTrainNo !== trainNo) {
    state.selectedTrip = null;
  }
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
  $('mapDateFilter')?.addEventListener('change', () => {
    state.selectedDateFilter = $('mapDateFilter').value || null;
    if (state.dashboard) renderDashboard(state.dashboard);
  });
  $('mapDateTodayBtn')?.addEventListener('click', () => {
    const d = new Date();
    const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    $('mapDateFilter').value = todayStr;
    state.selectedDateFilter = todayStr;
    if (state.dashboard) renderDashboard(state.dashboard);
  });
  $('mapDateYesterdayBtn')?.addEventListener('click', () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const yesterdayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    $('mapDateFilter').value = yesterdayStr;
    state.selectedDateFilter = yesterdayStr;
    if (state.dashboard) renderDashboard(state.dashboard);
  });
  $('mapDateAllBtn')?.addEventListener('click', () => {
    $('mapDateFilter').value = '';
    state.selectedDateFilter = null;
    if (state.dashboard) renderDashboard(state.dashboard);
  });

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
    if ($('repTotalStocksCard')) $('repTotalStocksCard').textContent = data.totalRollingStocks ?? 0;
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
  
  tbody.innerHTML = filtered.length ? filtered.map(row => {
    const locLink = row.location && row.location !== '-'
      ? `<a href="javascript:void(0)" onclick="focusLocationOnMap(${row.location})" style="color: #0d6efd; text-decoration: underline;">${escapeHtml(row.location)}</a>`
      : '-';
    return `
      <tr>
        <td><strong>${escapeHtml(row.rid)}</strong></td>
        <td>${row.count}</td>
        <td>${locLink}</td>
        <td>
          <div style="position: relative; display: inline-block;">
            <button class="dropdown-action-btn" onclick="toggleRowDropdown(event, '${row.rid}')"><i class="bi bi-eye"></i> View <i class="bi bi-chevron-down"></i></button>
            <div class="export-menu" id="dropdown-${row.rid}" style="top: 28px; min-width: 120px;">
              <button onclick="openAlarmLogFor('${row.rid}')" style="font-size:12px; padding:8px 12px; font-weight:600; text-align:left;">Alarm Log</button>
            </div>
          </div>
        </td>
      </tr>
    `;
  }).join('') : '<tr><td colspan="4">No results found.</td></tr>';
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
    feedbackStatus: null
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
  if ($('totalAlarmCard')) $('totalAlarmCard').textContent = summary.totalAlarmCount ?? 0;
  if ($('criticalAlarmCard')) $('criticalAlarmCard').textContent = summary.criticalAlarmCount ?? 0;
  if ($('maintenanceAlarmCard')) $('maintenanceAlarmCard').textContent = summary.maintenanceAlarmCount ?? 0;
  if ($('normalAlarmCard')) $('normalAlarmCard').textContent = summary.normalAlarmCount ?? 0;
}

function renderCurrentResultSet() {
  $('currentResultSection').style.display = "block";
  const rid = $('ridInput').value.trim() || "ALL";
  const alarmType = $('alarmTypeFilter').value || "ALL";
  const fromDate = $('fromDate').value;
  const toDate = $('toDate').value;
  
  $('currentRid').textContent = rid;
  $('currentAlarmType').textContent = alarmType;
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
  tbody.innerHTML = rows.length ? rows.map(row => {
    const locLink = row.location && row.location !== '-'
      ? `<a href="javascript:void(0)" onclick="focusLocationOnMap(${row.location})" style="color: #0d6efd; text-decoration: underline;">${escapeHtml(row.location)}</a>`
      : '-';
    return `
      <tr>
        <td>${DateUtils.formatDisplayDate(row.alarmDate)}</td>
        <td>${row.alarmTime}</td>
        <td>${escapeHtml(row.machineName)}</td>
        <td><strong>${escapeHtml(row.train)}</strong></td>
        <td>${locLink}</td>
      </tr>
    `;
  }).join('') : '<tr><td colspan="5">No results found.</td></tr>';
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

async function exportRepeatedAlarmPdf() {
  const payload = { fromDate: $('repFromDate').value, toDate: $('repToDate').value };
  try {
    const response = await fetch('/api/reports/repeated-alarm/export/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    await ExportUtils.downloadResponse(response, "RepeatedAlarms.pdf");
  } catch (error) {
    alert("Failed to export Repeated Alarms PDF.");
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

async function exportPdf() {
  const payload = {
    rid: $('ridInput').value.trim(),
    fromDate: $('fromDate').value,
    toDate: $('toDate').value,
    alarmType: $('alarmTypeFilter').value,
    feedbackStatus: $('feedbackStatusFilter').value
  };
  try {
    const response = await fetch('/api/reports/alarm-log/export/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    await ExportUtils.downloadResponse(response, "AlarmLog.pdf");
  } catch (error) {
    alert("Failed to export Alarm Log PDF.");
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
  $('repExportPdfBtn')?.addEventListener("click", exportRepeatedAlarmPdf);
  $('exportCsvBtn')?.addEventListener("click", exportCsv);
  $('exportExcelBtn')?.addEventListener("click", exportExcel);
  $('exportPdfBtn')?.addEventListener("click", exportPdf);
  
  $('closeFeedbackModalBtn')?.addEventListener("click", closeFeedbackModal);
  $('submitFeedbackBtn')?.addEventListener("click", submitFeedback);
  
  DateUtils.initializeDefaultDates("graphFromDate", "graphToDate");
  DateUtils.applyDateRangeConstraints("graphFromDate", "graphToDate");
  $('graphFromDate')?.addEventListener("change", () => DateUtils.applyDateRangeConstraints("graphFromDate", "graphToDate"));
  $('graphToDate')?.addEventListener("change", () => DateUtils.applyDateRangeConstraints("graphFromDate", "graphToDate"));
  $('loadGraphBtn')?.addEventListener("click", loadGraphData);
  
  initializeTableSorting();
}

window.openAlarmLogFor = openAlarmLogFor;
window.toggleRowDropdown = toggleRowDropdown;
window.showFeedbackModal = showFeedbackModal;
window.focusLocationOnMap = focusLocationOnMap;

async function loadGraphData() {
  let rid = $('graphRid').value.trim();
  if (!rid) {
    alert("Please enter a Rolling Stock ID (RID)");
    return;
  }
  // Extract real ID before " - " if present
  const idPart = rid.split(" - ")[0].trim();
  if (/^\d{3}$/.test(idPart)) {
    rid = "TR_" + idPart;
  } else {
    rid = idPart;
  }
  const fromDate = $('graphFromDate').value;
  const toDate = $('graphToDate').value;
  const metric = $('graphMetricFilter').value;
  
  try {
    const data = await ApiClient.post('/api/reports/graph/load', { rid, fromDate, toDate, metric });
     if (!data.points || data.points.length === 0) {
      alert("No telemetry records found for this train and date range.");
      if (chartXInstance) { chartXInstance.destroy(); chartXInstance = null; }
      if (chartYInstance) { chartYInstance.destroy(); chartYInstance = null; }
      if (chartZInstance) { chartZInstance.destroy(); chartZInstance = null; }
      $('graphMetadataSection').style.display = "none";
      $('graphMainContent').style.display = "none";
      return;
    }
    
    $('metaRollingStockId').textContent = data.rollingStockId;
    $('metaGraphDateRange').textContent = `${DateUtils.formatDisplayDateTime(fromDate)} → ${DateUtils.formatDisplayDateTime(toDate)}`;
    
    $('graphMetadataSection').style.display = "block";
    $('graphMainContent').style.display = "grid";
    
    renderRollingStockChart(data);
  } catch (error) {
    alert("Load Graph Error: " + error.message);
  }
}

function createAxisChart(canvasId, titleId, titleText, labels, dataPoints, dataColor, speeds, thresholdRed, thresholdYellow, thresholdGreen, hasDistance, rawPoints) {
  const canvas = $(canvasId);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  
  const titleElem = $(titleId);
  if (titleElem) {
    titleElem.textContent = titleText;
    titleElem.style.color = dataColor;
  }
  
  const pointsCount = dataPoints.length;
  
  // High critical peaks marker style (red dots with white border)
  const pointRadii = dataPoints.map(val => (val >= thresholdRed ? 5 : 0));
  const pointBackgroundColors = dataPoints.map(val => (val >= thresholdRed ? '#ef4444' : 'transparent'));
  const pointBorderColors = dataPoints.map(val => (val >= thresholdRed ? '#ffffff' : 'transparent'));
  const pointBorderWidths = dataPoints.map(val => (val >= thresholdRed ? 2 : 0));
  
  const chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'G-Force',
          data: dataPoints,
          borderColor: dataColor,
          backgroundColor: 'rgba(255, 255, 255, 0.02)',
          yAxisID: 'y',
          tension: 0.3,
          borderWidth: 2.5,
          pointRadius: pointRadii,
          pointBackgroundColor: pointBackgroundColors,
          pointBorderColor: pointBorderColors,
          pointBorderWidth: pointBorderWidths,
          fill: false
        },
        {
          label: 'Speed (km/h)',
          data: speeds,
          borderColor: '#9ca3af',
          backgroundColor: 'transparent',
          yAxisID: 'y1',
          tension: 0.3,
          borderWidth: 1.5,
          borderDash: [5, 5],
          pointRadius: 0,
          fill: false
        },
        {
          label: 'Critical Threshold',
          data: new Array(pointsCount).fill(thresholdRed),
          borderColor: '#ef4444',
          borderWidth: 1.5,
          borderDash: [4, 4],
          pointRadius: 0,
          yAxisID: 'y',
          fill: false
        },
        {
          label: 'Warning Threshold',
          data: new Array(pointsCount).fill(thresholdYellow),
          borderColor: '#f59e0b',
          borderWidth: 1.5,
          borderDash: [4, 4],
          pointRadius: 0,
          yAxisID: 'y',
          fill: false
        },
        {
          label: 'Normal Threshold',
          data: new Array(pointsCount).fill(thresholdGreen),
          borderColor: '#10b981',
          borderWidth: 1.5,
          borderDash: [4, 4],
          pointRadius: 0,
          yAxisID: 'y',
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            color: '#f3f4f6',
            boxWidth: 10,
            font: { family: 'Outfit, Inter, sans-serif', size: 9 }
          }
        },
        zoom: {
          zoom: {
            drag: {
              enabled: true,
              backgroundColor: 'rgba(29, 112, 184, 0.25)',
              borderColor: 'rgba(29, 112, 184, 0.6)',
              borderWidth: 1
            },
            mode: 'x'
          }
        },
        tooltip: {
          callbacks: {
            afterLabel: function(context) {
              if (context.datasetIndex === 0) {
                const pt = rawPoints[context.dataIndex];
                return `Time: ${pt.timestamp}`;
              }
              return '';
            }
          }
        }
      },
      scales: {
        y: {
          type: 'linear',
          display: true,
          position: 'left',
          title: {
            display: true,
            text: 'G-Force (G)',
            color: '#9ca3af',
            font: { family: 'Outfit, Inter, sans-serif', size: 9, weight: 'bold' }
          },
          grid: {
            color: 'rgba(73, 80, 87, 0.15)',
          },
          ticks: {
            color: '#9ca3af',
            font: { family: 'Outfit, Inter, sans-serif', size: 8 }
          }
        },
        y1: {
          type: 'linear',
          display: true,
          position: 'right',
          title: {
            display: true,
            text: 'Speed (km/h)',
            color: '#9ca3af',
            font: { family: 'Outfit, Inter, sans-serif', size: 9, weight: 'bold' }
          },
          grid: {
            drawOnChartArea: false,
          },
          ticks: {
            color: '#9ca3af',
            font: { family: 'Outfit, Inter, sans-serif', size: 8 }
          }
        },
        x: {
          title: {
            display: true,
            text: hasDistance ? 'Distance along route (KM)' : 'Time of Log',
            color: '#9ca3af',
            font: { family: 'Outfit, Inter, sans-serif', size: 9, weight: 'bold' }
          },
          grid: {
            color: 'rgba(73, 80, 87, 0.15)',
          },
          ticks: {
            color: '#9ca3af',
            font: { family: 'Outfit, Inter, sans-serif', size: 8 }
          }
        }
      }
    }
  });

  canvas.addEventListener('dblclick', () => {
    if (chartInstance && typeof chartInstance.resetZoom === 'function') {
      chartInstance.resetZoom();
    }
  });

  return chartInstance;
}

function zoomChart(axis, amount) {
  const chart = axis === 'X' ? chartXInstance : axis === 'Y' ? chartYInstance : chartZInstance;
  if (chart && typeof chart.zoom === 'function') {
    chart.zoom(amount);
  }
}

function resetChartZoom(axis) {
  const chart = axis === 'X' ? chartXInstance : axis === 'Y' ? chartYInstance : chartZInstance;
  if (chart && typeof chart.resetZoom === 'function') {
    chart.resetZoom();
  }
}

window.zoomChart = zoomChart;
window.resetChartZoom = resetChartZoom;

function renderRollingStockChart(data) {
  if (chartXInstance) { chartXInstance.destroy(); chartXInstance = null; }
  if (chartYInstance) { chartYInstance.destroy(); chartYInstance = null; }
  if (chartZInstance) { chartZInstance.destroy(); chartZInstance = null; }

  const selectedAxisValue = $('graphAxisFilter').value;
  const prefix = selectedAxisValue.startsWith('al') ? 'al' : selectedAxisValue.startsWith('ar') ? 'ar' : 'bg';
  const metric = $('graphMetricFilter').value;

  let cumulativeDist = 0.0;
  const labels = [];
  for (let i = 0; i < data.points.length; i++) {
    const pt = data.points[i];
    if (i > 0) {
      const prev = data.points[i - 1];
      const p1 = prev.positionKm || 0.0;
      const p2 = pt.positionKm || 0.0;
      if (p1 > 0 || p2 > 0) {
        cumulativeDist = pt.positionKm;
      } else if (prev.latitude !== null && prev.longitude !== null && pt.latitude !== null && pt.longitude !== null) {
        const d = haversineDistance(prev.latitude, prev.longitude, pt.latitude, pt.longitude);
        cumulativeDist += d;
      }
    } else {
      cumulativeDist = pt.positionKm || 0.0;
    }
    labels.push(cumulativeDist);
  }
  
  const hasDistance = labels.some(v => v > 0);
  const formattedLabels = data.points.map((pt, idx) => {
    if (hasDistance) {
      return `${labels[idx].toFixed(3)} KM`;
    }
    return pt.timestamp.split(" ")[1] || `${idx + 1}`;
  });
  
  const speeds = data.points.map(p => p.speed);

  // Set up thresholds based on Peak vs RMS metric type
  const isPeak = (metric === "Peak");
  const thresholdRed = isPeak ? 8.0 : 4.0;
  const thresholdYellow = isPeak ? 5.0 : 2.5;
  const thresholdGreen = isPeak ? 2.0 : 1.0;

  // Extract X, Y, and Z data arrays
  const xData = data.points.map(p => p.axes[`${prefix}_x`] ?? 0.0);
  const yData = data.points.map(p => p.axes[`${prefix}_y`] ?? 0.0);
  const zData = data.points.map(p => p.axes[`${prefix}_z`] ?? 0.0);

  // Render X Axis Chart (Red line)
  chartXInstance = createAxisChart(
    'chartX', 'chartXTitle', `X Axis — ${metric} Acceleration (${prefix}_x)`,
    formattedLabels, xData, '#ef4444', speeds, thresholdRed, thresholdYellow, thresholdGreen, hasDistance, data.points
  );

  // Render Y Axis Chart (Green line)
  chartYInstance = createAxisChart(
    'chartY', 'chartYTitle', `Y Axis — ${metric} Acceleration (${prefix}_y)`,
    formattedLabels, yData, '#10b981', speeds, thresholdRed, thresholdYellow, thresholdGreen, hasDistance, data.points
  );

  // Render Z Axis Chart (Blue line)
  chartZInstance = createAxisChart(
    'chartZ', 'chartZTitle', `Z Axis — ${metric} Acceleration (${prefix}_z)`,
    formattedLabels, zData, '#3b82f6', speeds, thresholdRed, thresholdYellow, thresholdGreen, hasDistance, data.points
  );

  // Calculate alert counts for each axis separately
  let critX = 0, warnX = 0, normX = 0;
  let critY = 0, warnY = 0, normY = 0;
  let critZ = 0, warnZ = 0, normZ = 0;

  for (let i = 0; i < data.points.length; i++) {
    const pt = data.points[i];
    const x = pt.axes[`${prefix}_x`] ?? 0.0;
    const y = pt.axes[`${prefix}_y`] ?? 0.0;
    const z = pt.axes[`${prefix}_z`] ?? 0.0;
    
    // X Axis Alerts
    if (x >= thresholdRed) critX++;
    else if (x >= thresholdYellow) warnX++;
    else normX++;

    // Y Axis Alerts
    if (y >= thresholdRed) critY++;
    else if (y >= thresholdYellow) warnY++;
    else normY++;

    // Z Axis Alerts
    if (z >= thresholdRed) critZ++;
    else if (z >= thresholdYellow) warnZ++;
    else normZ++;
  }

  // Populate sidebar indicators
  setText('sbCriticalX', critX);
  setText('sbWarningX', warnX);
  setText('sbNormalX', normX);

  setText('sbCriticalY', critY);
  setText('sbWarningY', warnY);
  setText('sbNormalY', normY);

  setText('sbCriticalZ', critZ);
  setText('sbWarningZ', warnZ);
  setText('sbNormalZ', normZ);
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  if (lat1 === undefined || lon1 === undefined || lat2 === undefined || lon2 === undefined) return 0;
  if (lat1 === null || lon1 === null || lat2 === null || lon2 === null) return 0;
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function focusLocationOnMap(lat, lon) {
  selectTab('alerts');
  setTimeout(() => {
    Object.keys(maps).forEach(gatewayId => {
      const map = maps[gatewayId];
      if (map) {
        map.setView([lat, lon], 14);
        map.invalidateSize();
      }
    });
  }, 150);
}
window.focusLocationOnMap = focusLocationOnMap;


boot();
