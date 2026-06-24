from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class HandshakeRequest(BaseModel):
    gatewayId: str = Field(..., examples=["GW1"])
    trainId: str = Field(..., examples=["12345"])
    gatewaySerial: str = Field(..., examples=["SN001"])
    firmwareVersion: str = Field(..., examples=["1.0"])


class AuthRequest(BaseModel):
    gatewayId: str = Field(..., examples=["GW1"])
    apiKey: str = Field(..., examples=["123456"])


class HeartbeatRequest(BaseModel):
    gatewayId: str = Field(..., examples=["GW1"])
    token: str = Field(..., examples=["jwt_token"])


class CalibrationValues(BaseModel):
    x: float = 1.0
    y: float = 1.0
    z: float = 1.0


class CalibrationUpdateRequest(BaseModel):
    leftWheelFactor: float = 1.0
    rightWheelFactor: float = 1.0
    adxlLeft: CalibrationValues = Field(default_factory=CalibrationValues)
    adxlRight: CalibrationValues = Field(default_factory=CalibrationValues)
    bogie: dict = Field(default_factory=dict)
    encoder: dict = Field(default_factory=dict)


class AlertRequest(BaseModel):
    gatewayId: str | None = None
    trainNo: str | None = None
    latitude: float
    longitude: float
    peakValueG: float


class ResetSessionRequest(BaseModel):
    trainNo: str


class GatewayStatus(BaseModel):
    gatewayId: str
    online: bool
    lastHeartbeat: datetime | None = None
    status: Literal["active", "inactive"] = "active"
