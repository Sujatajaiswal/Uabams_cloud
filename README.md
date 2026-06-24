# UABAMS Cloud Prototype

FastAPI backend and browser dashboard for UABAMS gateway communication.

## Local Run

```powershell
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload
```

Open:

```text
Dashboard: http://127.0.0.1:8000/dashboard
Swagger:   http://127.0.0.1:8000/docs
Health:    http://127.0.0.1:8000/
```

## Gateway APIs

```text
PUT  /api/v1/archive
POST /api/v1/alert
GET  /api/v1/calibration/{gatewayId}
GET  /api/v1/map/alerts?train_id=019456
GET  /api/v1/map/rms?train_id=019456
GET  /api/v1/trains/{trainNo}/dashboard
POST /api/v1/sessions/reset
```

Gateway APIs require:

```text
X-Gateway-Id
X-Train-Id
X-Api-Key
```

Reset requires:

```text
X-Admin-Key
```

## Frontend Screens

- Dashboard with separate GW1/GW2 status boxes
- Online gateway boxes show green, offline boxes show red
- Calibration split into GW1 and GW2 panels
- Calibration save is blocked until "Destination reached" is selected
- Alert screen uses OpenLayers + OpenStreetMap with separate maps for GW1 and GW2
- Archive upload history with SHA-256
- Protected reset session screen

## Render Deployment

Use `render.yaml`, then add these environment variables in Render:

```text
MONGODB_URL
DATABASE_NAME
GATEWAY_API_KEY_GW01
GATEWAY_API_KEY_GW02
JWT_SECRET
ADMIN_RESET_KEY
```

Do not commit `.env`.
