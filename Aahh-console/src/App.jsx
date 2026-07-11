import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Leaf, Bug, Droplets, Thermometer, Wifi, WifiOff, Bell, BellOff, Settings, X, Power, RotateCw, Video, Play, Film, Gauge, Waves, Check, Sprout } from 'lucide-react';

const FONT_DISPLAY = "'Big Shoulders Text', sans-serif";
const FONT_DATA = "'IBM Plex Mono', monospace";

export default function AahhFieldConsole() {
  const [config, setConfig] = useState({ url: '', anonKey: '' });
  const [configOpen, setConfigOpen] = useState(true);
  const [draft, setDraft] = useState({ url: '', anonKey: '' });

  const [connected, setConnected] = useState(false);
  const [lastError, setLastError] = useState(null);
  const [state, setState] = useState({
    last_temp: null,
    last_hum: null,
    alarm_active: false,
    irrigation_active: false,
    soil_moisture_pct: null,
    water_level_pct: null,
    flow_rate_lpm: null,
    last_seen_at: null,
  });
  const [log, setLog] = useState([]);
  const [notifPermission, setNotifPermission] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  );
  const [polling, setPolling] = useState(false);

  const [clips, setClips] = useState([]);
  const [detections, setDetections] = useState([]);
  const [ackBusyId, setAckBusyId] = useState(null);
  const [recordBusy, setRecordBusy] = useState(false);
  const [viewerClip, setViewerClip] = useState(null);
  const [viewerFrames, setViewerFrames] = useState([]);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [viewerLoading, setViewerLoading] = useState(false);

  const prevAlarm = useRef(false);
  const intervalRef = useRef(null);
  const clipsIntervalRef = useRef(null);
  const detectionsIntervalRef = useRef(null);
  const slideshowRef = useRef(null);

  const pushLog = useCallback((kind, message) => {
    setLog(prev => [{ id: Date.now() + Math.random(), kind, message, time: new Date() }, ...prev].slice(0, 40));
  }, []);

  const notify = useCallback((title, body) => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification(title, { body }); } catch (e) { /* no-op */ }
    }
  }, []);

  const fetchState = useCallback(async () => {
    if (!config.url || !config.anonKey) return;
    try {
      const res = await fetch(`${config.url}/rest/v1/system_controls?id=eq.1`, {
        headers: {
          apikey: config.anonKey,
          Authorization: `Bearer ${config.anonKey}`,
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error('No system_controls row returned');

      setConnected(true);
      setLastError(null);

      if (row.alarm_active && !prevAlarm.current) {
        pushLog('alert', 'Pest detected — AI confidence above threshold');
        notify('AAHH — Pest detected', 'The field node flagged a pest above the confidence threshold.');
      }
      prevAlarm.current = !!row.alarm_active;

      setState(prev => {
        if (prev.last_temp !== row.last_temp || prev.last_hum !== row.last_hum) {
          pushLog('telemetry', `Reading: ${row.last_temp ?? '—'}°C, ${row.last_hum ?? '—'}% RH`);
        }
        if (prev.soil_moisture_pct !== row.soil_moisture_pct && row.soil_moisture_pct != null) {
          pushLog('telemetry', `Soil moisture: ${row.soil_moisture_pct}%`);
        }
        return {
          last_temp: row.last_temp,
          last_hum: row.last_hum,
          alarm_active: !!row.alarm_active,
          irrigation_active: !!row.irrigation_active,
          soil_moisture_pct: row.soil_moisture_pct,
          water_level_pct: row.water_level_pct,
          flow_rate_lpm: row.flow_rate_lpm,
          last_seen_at: row.last_seen_at,
        };
      });
    } catch (err) {
      setConnected(false);
      setLastError(err.message || 'Connection failed');
    }
  }, [config, pushLog, notify]);

  const fetchClips = useCallback(async () => {
    if (!config.url || !config.anonKey) return;
    try {
      const res = await fetch(
        `${config.url}/rest/v1/clips?order=created_at.desc&limit=10`,
        { headers: { apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}` } }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setClips(data);
    } catch (err) {
      // silent — clip list is secondary to the main telemetry connection
    }
  }, [config]);

  const fetchDetections = useCallback(async () => {
    if (!config.url || !config.anonKey) return;
    try {
      const res = await fetch(
        `${config.url}/rest/v1/detections?order=created_at.desc&limit=20`,
        { headers: { apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}` } }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDetections(prev => {
        if (prev.length && data.length && prev[0]?.id !== data[0]?.id && data[0]?.kind !== 'healthy') {
          pushLog('alert', `${data[0].kind === 'pest' ? 'Pest' : 'Disease'} detected: ${data[0].label ?? 'unknown'}`);
        }
        return data;
      });
    } catch (err) {
      // silent — detections list is secondary to the main telemetry connection
    }
  }, [config, pushLog]);

  const acknowledgeDetection = async (id) => {
    if (!config.url || !config.anonKey) return;
    setAckBusyId(id);
    try {
      const res = await fetch(`${config.url}/rest/v1/detections?id=eq.${id}`, {
        method: 'PATCH',
        headers: {
          apikey: config.anonKey,
          Authorization: `Bearer ${config.anonKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ acknowledged: true }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDetections(prev => prev.map(d => d.id === id ? { ...d, acknowledged: true } : d));
    } catch (err) {
      pushLog('error', `Acknowledge failed: ${err.message}`);
    } finally {
      setAckBusyId(null);
    }
  };

  useEffect(() => {
    if (polling) {
      fetchState();
      fetchClips();
      fetchDetections();
      intervalRef.current = setInterval(fetchState, 4000);
      clipsIntervalRef.current = setInterval(fetchClips, 6000);
      detectionsIntervalRef.current = setInterval(fetchDetections, 5000);
      return () => {
        clearInterval(intervalRef.current);
        clearInterval(clipsIntervalRef.current);
        clearInterval(detectionsIntervalRef.current);
      };
    }
  }, [polling, fetchState, fetchClips, fetchDetections]);

  const startClip = async (durationSeconds) => {
    if (!config.url || !config.anonKey) return;
    setRecordBusy(true);
    try {
      const res = await fetch(`${config.url}/rest/v1/system_controls?id=eq.1`, {
        method: 'PATCH',
        headers: {
          apikey: config.anonKey,
          Authorization: `Bearer ${config.anonKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ record_clip: true, record_duration_seconds: durationSeconds }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      pushLog('command', `Recording requested — ${durationSeconds / 60} min`);
    } catch (err) {
      pushLog('error', `Recording request failed: ${err.message}`);
    } finally {
      setTimeout(() => setRecordBusy(false), 2000);
    }
  };

  const openClip = async (clip) => {
    setViewerClip(clip);
    setViewerFrames([]);
    setViewerIndex(0);
    setViewerLoading(true);
    try {
      const res = await fetch(`${config.url}/storage/v1/object/list/field-clips`, {
        method: 'POST',
        headers: {
          apikey: config.anonKey,
          Authorization: `Bearer ${config.anonKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prefix: clip.storage_prefix || clip.id, limit: 1000 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const objects = await res.json();
      const prefix = clip.storage_prefix || clip.id;
      const urls = objects
        .filter(o => o.name && o.name.endsWith('.jpg'))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(o => `${config.url}/storage/v1/object/public/field-clips/${prefix}/${o.name}`);
      setViewerFrames(urls);
    } catch (err) {
      pushLog('error', `Could not load clip frames: ${err.message}`);
    } finally {
      setViewerLoading(false);
    }
  };

  useEffect(() => {
    if (viewerFrames.length > 1) {
      slideshowRef.current = setInterval(() => {
        setViewerIndex(i => (i + 1) % viewerFrames.length);
      }, 500);
      return () => clearInterval(slideshowRef.current);
    }
  }, [viewerFrames]);

  const closeViewer = () => {
    clearInterval(slideshowRef.current);
    setViewerClip(null);
    setViewerFrames([]);
  };

  const startConnection = () => {
    if (!draft.url || !draft.anonKey) return;
    setConfig({ url: draft.url.replace(/\/$/, ''), anonKey: draft.anonKey });
    setConfigOpen(false);
    setPolling(true);
    pushLog('system', 'Connected to Supabase project');
  };

  const requestNotifPermission = () => {
    if (typeof Notification === 'undefined') return;
    Notification.requestPermission().then(setNotifPermission);
  };

  const patchControl = async (field, value) => {
    if (!config.url || !config.anonKey) return;
    try {
      const res = await fetch(`${config.url}/rest/v1/system_controls?id=eq.1`, {
        method: 'PATCH',
        headers: {
          apikey: config.anonKey,
          Authorization: `Bearer ${config.anonKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState(prev => ({ ...prev, [field]: value }));
      pushLog('command', `${field === 'irrigation_active' ? 'Irrigation' : 'Alarm'} set to ${value ? 'ON' : 'OFF'}`);
    } catch (err) {
      pushLog('error', `Command failed: ${err.message}`);
    }
  };

  const disconnect = () => {
    setPolling(false);
    setConnected(false);
    clearInterval(intervalRef.current);
    pushLog('system', 'Disconnected');
  };

  // Device considered offline if last_seen_at is older than 30s, even while "connected" to Supabase
  const deviceStale = state.last_seen_at
    ? (Date.now() - new Date(state.last_seen_at).getTime()) > 30000
    : false;

  return (
    <div style={styles.page}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Big+Shoulders+Text:wght@600;700;800&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        ::selection { background: #c9773f55; }
        button { cursor: pointer; font-family: ${FONT_DATA}; }
        button:focus-visible, input:focus-visible { outline: 2px solid #d98a4f; outline-offset: 2px; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
        @keyframes slideIn { from{opacity:0; transform:translateY(-6px);} to{opacity:1; transform:translateY(0);} }
      `}</style>

      {/* Header */}
      <header style={styles.header}>
        <div style={styles.brandRow}>
          <Leaf size={26} color="#d98a4f" strokeWidth={2.2} />
          <div>
            <div style={styles.brandTitle}>AAHH FIELD CONSOLE</div>
            <div style={styles.brandSub}>autonomous agricultural health &amp; hydration</div>
          </div>
        </div>
        <div style={styles.headerRight}>
          <ConnBadge connected={connected} error={lastError} stale={deviceStale} />
          <button style={styles.iconBtn} onClick={() => setConfigOpen(true)} aria-label="Settings">
            <Settings size={18} color="#e9dcc8" />
          </button>
        </div>
      </header>

      {/* Config panel */}
      {configOpen && (
        <div style={styles.overlay}>
          <div style={styles.configCard}>
            <div style={styles.configHead}>
              <span style={{ fontFamily: FONT_DISPLAY, fontSize: 20, fontWeight: 700, letterSpacing: 0.5 }}>
                Connect your node
              </span>
              {config.url && (
                <button style={styles.xBtn} onClick={() => setConfigOpen(false)} aria-label="Close">
                  <X size={18} color="#e9dcc8" />
                </button>
              )}
            </div>
            <p style={styles.configHint}>
              Point this console at the Supabase project your ESP32-CAM syncs with. Values stay in this
              browser tab only — they clear on refresh, nothing is saved to a server.
            </p>
            <label style={styles.label}>Supabase project URL</label>
            <input
              style={styles.input}
              placeholder="https://your-project-id.supabase.co"
              value={draft.url}
              onChange={e => setDraft(d => ({ ...d, url: e.target.value }))}
            />
            <label style={styles.label}>Anon public key</label>
            <input
              style={styles.input}
              type="password"
              placeholder="eyJhbGciOi..."
              value={draft.anonKey}
              onChange={e => setDraft(d => ({ ...d, anonKey: e.target.value }))}
            />
            <button style={styles.primaryBtn} onClick={startConnection}>
              <Wifi size={16} /> Connect
            </button>

            <div style={styles.notifRow}>
              {notifPermission === 'granted' ? (
                <span style={styles.notifOk}><Bell size={14} /> Browser alerts enabled</span>
              ) : (
                <button style={styles.notifBtn} onClick={requestNotifPermission}>
                  <BellOff size={14} /> Enable browser alerts
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main dashboard */}
      <main style={styles.main}>
        <section style={styles.statusGrid}>
          <AlertCard alarm={state.alarm_active} onClear={() => patchControl('alarm_active', false)} />
          <ReadingCard
            icon={<Thermometer size={20} color="#e9dcc8" />}
            label="Temperature"
            value={state.last_temp != null ? `${state.last_temp}°C` : '—'}
          />
          <ReadingCard
            icon={<Droplets size={20} color="#e9dcc8" />}
            label="Humidity"
            value={state.last_hum != null ? `${state.last_hum}%` : '—'}
          />
          <IrrigationCard
            active={state.irrigation_active}
            onToggle={() => patchControl('irrigation_active', !state.irrigation_active)}
          />
        </section>

        <section style={styles.statusGrid}>
          <MoistureCard value={state.soil_moisture_pct} />
          <ReadingCard
            icon={<Waves size={20} color="#8fc0d9" />}
            label="Water level"
            value={state.water_level_pct != null ? `${state.water_level_pct}%` : '—'}
            warn={state.water_level_pct != null && state.water_level_pct < 15}
          />
          <ReadingCard
            icon={<Gauge size={20} color="#e9dcc8" />}
            label="Flow rate"
            value={state.flow_rate_lpm != null ? `${state.flow_rate_lpm} L/min` : '—'}
          />
        </section>

        <section style={styles.logSection}>
          <div style={styles.logHeadRow}>
            <span style={styles.logTitle}>CROP DETECTIONS</span>
            <span style={{ fontSize: 10.5, color: '#8a7c62' }}>
              {detections.filter(d => !d.acknowledged && d.kind !== 'healthy').length} unacknowledged
            </span>
          </div>
          <div style={styles.clipList}>
            {detections.length === 0 && (
              <div style={styles.logEmpty}>
                No detections yet. The ESP32-CAM will log a row here every time it classifies a frame.
              </div>
            )}
            {detections.map(d => (
              <DetectionRow key={d.id} detection={d} busy={ackBusyId === d.id} onAck={() => acknowledgeDetection(d.id)} />
            ))}
          </div>
        </section>

        <section style={styles.logSection}>
          <div style={styles.logHeadRow}>
            <span style={styles.logTitle}>FIELD LOG</span>
            {polling && (
              <span style={styles.liveTag}>
                <RotateCw size={12} style={{ animation: 'pulse 1.6s infinite' }} /> live — polling every 4s
              </span>
            )}
          </div>
          <div style={styles.logList}>
            {log.length === 0 && (
              <div style={styles.logEmpty}>
                No entries yet. Connect a node above — readings and pest alerts will appear here as they arrive.
              </div>
            )}
            {log.map(entry => (
              <LogRow key={entry.id} entry={entry} />
            ))}
          </div>
        </section>

        <section style={styles.logSection}>
          <div style={styles.logHeadRow}>
            <span style={styles.logTitle}>FIELD RECORDINGS</span>
            <span style={{ fontSize: 10.5, color: '#8a7c62' }}>~1–2 fps frame capture, not smooth video</span>
          </div>

          <div style={styles.recordRow}>
            {[60, 120, 300].map(secs => (
              <button
                key={secs}
                style={styles.recordBtn}
                disabled={!connected || recordBusy}
                onClick={() => startClip(secs)}
              >
                <Video size={13} /> Record {secs / 60} min
              </button>
            ))}
          </div>

          <div style={styles.clipList}>
            {clips.length === 0 && (
              <div style={styles.logEmpty}>
                No recordings yet. Request one above — the node will upload frames as it captures them.
              </div>
            )}
            {clips.map(clip => (
              <button key={clip.id} style={styles.clipRow} onClick={() => openClip(clip)}>
                <Film size={15} color={clip.status === 'complete' ? '#a8c98f' : '#d98a4f'} />
                <span style={{ flex: 1, textAlign: 'left' }}>
                  {new Date(clip.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                  {' · '}{clip.duration_seconds}s
                </span>
                <span style={{
                  fontSize: 10.5,
                  color: clip.status === 'complete' ? '#a8c98f' : '#d98a4f',
                  textTransform: 'uppercase',
                }}>
                  {clip.status === 'complete' ? `${clip.frame_count} frames` : 'recording…'}
                </span>
              </button>
            ))}
          </div>
        </section>

        {connected && (
          <button style={styles.disconnectBtn} onClick={disconnect}>
            <Power size={14} /> Disconnect
          </button>
        )}
      </main>

      {viewerClip && (
        <div style={styles.overlay} onClick={closeViewer}>
          <div style={styles.viewerCard} onClick={e => e.stopPropagation()}>
            <div style={styles.configHead}>
              <span style={{ fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 700 }}>
                Clip — {new Date(viewerClip.created_at).toLocaleTimeString()}
              </span>
              <button style={styles.xBtn} onClick={closeViewer}><X size={18} color="#e9dcc8" /></button>
            </div>
            <div style={styles.viewerFrame}>
              {viewerLoading && <span style={{ color: '#a8987c', fontSize: 12.5 }}>Loading frames…</span>}
              {!viewerLoading && viewerFrames.length === 0 && (
                <span style={{ color: '#a8987c', fontSize: 12.5 }}>No frames found for this clip yet.</span>
              )}
              {!viewerLoading && viewerFrames.length > 0 && (
                <img
                  src={viewerFrames[viewerIndex]}
                  alt={`frame ${viewerIndex + 1}`}
                  style={styles.viewerImg}
                />
              )}
            </div>
            {viewerFrames.length > 0 && (
              <div style={styles.viewerFooter}>
                <Play size={12} /> frame {viewerIndex + 1} / {viewerFrames.length}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ConnBadge({ connected, error, stale }) {
  const label = connected ? (stale ? 'STALE DATA' : 'ONLINE') : (error ? 'OFFLINE' : 'NOT CONNECTED');
  const color = connected ? (stale ? '#d9a84f' : '#a8c98f') : '#d99575';
  const borderColor = connected ? (stale ? '#8f7a45' : '#6f8f5a') : '#8a5a45';
  return (
    <div style={{ ...styles.connBadge, borderColor, color }}>
      {connected ? <Wifi size={14} /> : <WifiOff size={14} />}
      {label}
    </div>
  );
}

function AlertCard({ alarm, onClear }) {
  return (
    <div style={{
      ...styles.card,
      background: alarm ? 'linear-gradient(160deg, #6b2e20, #4a1f16)' : styles.card.background,
      borderColor: alarm ? '#c15a3f' : styles.card.borderColor,
    }}>
      <div style={styles.cardTop}>
        <Bug size={20} color={alarm ? '#ffd9c4' : '#e9dcc8'} />
        <span style={styles.cardLabel}>Pest status</span>
      </div>
      <div style={{ ...styles.cardValue, color: alarm ? '#ffd9c4' : '#a8c98f', fontSize: 22 }}>
        {alarm ? 'PEST DETECTED' : 'Clear'}
      </div>
      {alarm && (
        <button style={styles.clearBtn} onClick={onClear}>Acknowledge &amp; clear</button>
      )}
    </div>
  );
}

function ReadingCard({ icon, label, value, warn }) {
  return (
    <div style={{
      ...styles.card,
      borderColor: warn ? '#c15a3f' : styles.card.borderColor,
    }}>
      <div style={styles.cardTop}>{icon}<span style={styles.cardLabel}>{label}</span></div>
      <div style={{ ...styles.cardValue, color: warn ? '#ff9d7a' : styles.cardValue.color }}>{value}</div>
    </div>
  );
}

function MoistureCard({ value }) {
  const low = value != null && value < 30;
  const high = value != null && value > 60;
  return (
    <div style={{
      ...styles.card,
      borderColor: low ? '#c15a3f' : styles.card.borderColor,
    }}>
      <div style={styles.cardTop}>
        <Droplets size={20} color={low ? '#ff9d7a' : '#a8c98f'} />
        <span style={styles.cardLabel}>Soil moisture</span>
      </div>
      <div style={{ ...styles.cardValue, color: low ? '#ff9d7a' : '#e9dcc8' }}>
        {value != null ? `${value}%` : '—'}
      </div>
      {value != null && (
        <div style={styles.moistureBarTrack}>
          <div style={{
            ...styles.moistureBarFill,
            width: `${Math.min(100, Math.max(0, value))}%`,
            background: low ? '#c15a3f' : high ? '#8fc0d9' : '#a8c98f',
          }} />
        </div>
      )}
    </div>
  );
}

function IrrigationCard({ active, onToggle }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardTop}>
        <Droplets size={20} color={active ? '#8fc0d9' : '#e9dcc8'} />
        <span style={styles.cardLabel}>Irrigation</span>
      </div>
      <div style={{ ...styles.cardValue, color: active ? '#8fc0d9' : '#e9dcc8' }}>
        {active ? 'Running' : 'Idle'}
      </div>
      <button style={{ ...styles.clearBtn, background: active ? '#2c4652' : '#3a3226' }} onClick={onToggle}>
        {active ? 'Stop irrigation' : 'Start irrigation'}
      </button>
    </div>
  );
}

function LogRow({ entry }) {
  const colors = {
    alert: '#ff9d7a',
    telemetry: '#c9b898',
    system: '#8fc0d9',
    command: '#a8c98f',
    error: '#e07f7f',
  };
  const timeStr = entry.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (
    <div style={{ ...styles.logRow, animation: 'slideIn 0.25s ease' }}>
      <span style={{ ...styles.logDot, background: colors[entry.kind] || '#c9b898' }} />
      <span style={styles.logTime}>{timeStr}</span>
      <span style={{ color: colors[entry.kind] || '#e9dcc8' }}>{entry.message}</span>
    </div>
  );
}

function DetectionRow({ detection, busy, onAck }) {
  const isHealthy = detection.kind === 'healthy';
  const icon = isHealthy ? <Sprout size={16} color="#a8c98f" /> : <Bug size={16} color="#ff9d7a" />;
  const confidencePct = detection.confidence != null ? Math.round(detection.confidence * 100) : null;

  return (
    <div style={styles.detectionRow}>
      {detection.image_url ? (
        <img src={detection.image_url} alt={detection.label || detection.kind} style={styles.detectionThumb} />
      ) : (
        <div style={styles.detectionThumbPlaceholder}>{icon}</div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {icon}
          <span style={{ fontSize: 13, color: isHealthy ? '#a8c98f' : '#ffd9c4', fontWeight: 600 }}>
            {detection.label || (isHealthy ? 'Healthy' : detection.kind)}
          </span>
        </div>
        <div style={{ fontSize: 11, color: '#8a7c62', marginTop: 3 }}>
          {new Date(detection.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
          {confidencePct != null && ` · ${confidencePct}% confidence`}
        </div>
      </div>
      {!isHealthy && !detection.acknowledged && (
        <button style={styles.ackBtn} disabled={busy} onClick={onAck}>
          <Check size={13} /> {busy ? '...' : 'Ack'}
        </button>
      )}
      {!isHealthy && detection.acknowledged && (
        <span style={{ fontSize: 10.5, color: '#7a6d57' }}>acknowledged</span>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    background: 'linear-gradient(180deg, #201a13 0%, #17130d 100%)',
    color: '#e9dcc8',
    fontFamily: FONT_DATA,
    paddingBottom: 60,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '18px 22px',
    borderBottom: '1px solid #3a3226',
  },
  brandRow: { display: 'flex', alignItems: 'center', gap: 12 },
  brandTitle: { fontFamily: FONT_DISPLAY, fontSize: 20, fontWeight: 800, letterSpacing: 1.5 },
  brandSub: { fontSize: 10.5, letterSpacing: 1, color: '#9a8b70', marginTop: 2, textTransform: 'uppercase' },
  headerRight: { display: 'flex', alignItems: 'center', gap: 12 },
  iconBtn: { background: 'transparent', border: '1px solid #3a3226', borderRadius: 6, padding: 7 },
  connBadge: {
    display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, letterSpacing: 1,
    padding: '5px 10px', borderRadius: 20, border: '1px solid',
  },
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(10,8,5,0.72)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 20,
  },
  configCard: {
    background: '#241d14', border: '1px solid #4a3f2c', borderRadius: 10,
    padding: 26, width: '100%', maxWidth: 420,
  },
  configHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  xBtn: { background: 'transparent', border: 'none' },
  configHint: { fontSize: 12, color: '#a8987c', lineHeight: 1.6, marginBottom: 18 },
  label: { display: 'block', fontSize: 10.5, letterSpacing: 1, color: '#c9b898', marginBottom: 6, textTransform: 'uppercase' },
  input: {
    width: '100%', background: '#1a150e', border: '1px solid #4a3f2c', borderRadius: 6,
    padding: '10px 12px', color: '#e9dcc8', fontSize: 13, marginBottom: 16, fontFamily: FONT_DATA,
  },
  primaryBtn: {
    width: '100%', background: '#c9773f', border: 'none', borderRadius: 6, color: '#241d14',
    padding: '11px 0', fontSize: 13, fontWeight: 700, letterSpacing: 0.5,
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  notifRow: { marginTop: 16, display: 'flex', justifyContent: 'center' },
  notifOk: { fontSize: 11.5, color: '#a8c98f', display: 'flex', alignItems: 'center', gap: 6 },
  notifBtn: {
    background: 'transparent', border: '1px solid #4a3f2c', borderRadius: 6, color: '#c9b898',
    fontSize: 11.5, padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 6,
  },
  main: { maxWidth: 900, margin: '0 auto', padding: '28px 20px 0' },
  statusGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 14,
  },
  card: {
    background: '#241d14', border: '1px solid #3a3226', borderRadius: 10, padding: 16,
    display: 'flex', flexDirection: 'column', gap: 10, minHeight: 128,
  },
  cardTop: { display: 'flex', alignItems: 'center', gap: 8 },
  cardLabel: { fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', color: '#a8987c' },
  cardValue: { fontFamily: FONT_DISPLAY, fontSize: 26, fontWeight: 700, marginTop: 'auto', color: '#e9dcc8' },
  moistureBarTrack: {
    width: '100%', height: 6, borderRadius: 3, background: '#1a150e', overflow: 'hidden',
  },
  moistureBarFill: {
    height: '100%', borderRadius: 3, transition: 'width 0.4s ease',
  },
  clearBtn: {
    border: 'none', borderRadius: 6, padding: '8px 0', fontSize: 11.5, fontWeight: 600,
    color: '#e9dcc8', background: '#3a3226', letterSpacing: 0.3,
  },
  logSection: { background: '#1c1710', border: '1px solid #3a3226', borderRadius: 10, padding: 18, marginBottom: 16 },
  logHeadRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  logTitle: { fontFamily: FONT_DISPLAY, fontSize: 15, letterSpacing: 2, color: '#c9b898' },
  liveTag: { fontSize: 10.5, color: '#8fc0d9', display: 'flex', alignItems: 'center', gap: 6 },
  logList: { display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' },
  logEmpty: { fontSize: 12.5, color: '#7a6d57', padding: '20px 4px', lineHeight: 1.6 },
  logRow: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, padding: '4px 2px' },
  logDot: { width: 6, height: 6, borderRadius: '50%', flexShrink: 0 },
  logTime: { color: '#7a6d57', fontSize: 11, minWidth: 68 },
  disconnectBtn: {
    marginTop: 20, background: 'transparent', border: '1px solid #4a3226', color: '#c98f6a',
    borderRadius: 6, padding: '8px 14px', fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 6,
  },
  recordRow: { display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' },
  recordBtn: {
    background: '#3a2f1e', border: '1px solid #5a4a30', color: '#e9c896', borderRadius: 6,
    padding: '8px 12px', fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 6,
  },
  clipList: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' },
  detectionRow: {
    display: 'flex', alignItems: 'center', gap: 10, background: '#241d14', border: '1px solid #3a3226',
    borderRadius: 6, padding: '9px 12px',
  },
  detectionThumb: {
    width: 44, height: 44, borderRadius: 6, objectFit: 'cover', flexShrink: 0, background: '#1a150e',
  },
  detectionThumbPlaceholder: {
    width: 44, height: 44, borderRadius: 6, flexShrink: 0, background: '#1a150e',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  ackBtn: {
    background: '#3a2f1e', border: '1px solid #5a4a30', color: '#e9c896', borderRadius: 6,
    padding: '6px 10px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
  },
  clipRow: {
    display: 'flex', alignItems: 'center', gap: 10, background: '#241d14', border: '1px solid #3a3226',
    borderRadius: 6, padding: '9px 12px', fontSize: 12, color: '#e9dcc8', textAlign: 'left',
  },
  viewerCard: {
    background: '#241d14', border: '1px solid #4a3f2c', borderRadius: 10,
    padding: 22, width: '100%', maxWidth: 460,
  },
  viewerFrame: {
    background: '#0f0c08', borderRadius: 8, minHeight: 260, display: 'flex',
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginTop: 12,
  },
  viewerImg: { width: '100%', display: 'block' },
  viewerFooter: {
    marginTop: 10, fontSize: 11, color: '#a8987c', display: 'flex', alignItems: 'center', gap: 6,
  },
};
