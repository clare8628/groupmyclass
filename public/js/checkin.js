/* 學生自主點名：登入 → 取得驗證碼 → 即時相機拍照（燒入姓名／時間／驗證碼）→ 附定位上傳 */
(() => {
  const $ = id => document.getElementById(id);
  const courseId = new URLSearchParams(location.search).get('c') || '';
  const deviceId = localStorage.getItem('gs_device') || (() => {
    const v = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/-/g, '');
    localStorage.setItem('gs_device', v);
    return v;
  })();
  let st = null, challenge = null, stream = null, photo = '', pos = null;

  const say = (text, cls = 'info') => { const el = $('status'); el.textContent = text; el.className = `msg ${cls}`; };
  const api = async (path, body) => {
    const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `錯誤 ${res.status}`), { status: res.status });
    return data;
  };
  const stopCam = () => { if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; };

  async function refresh() {
    $('loginCard').hidden = $('shotCard').hidden = true;
    try {
      st = await api('/api/checkin/status');
    } catch (e) {
      if (e.status === 401) { say('請先登入'); $('loginCard').hidden = false; return; }
      return say(e.message, 'err');
    }
    $('title').textContent = st.courseName || '自主點名';
    $('who').textContent = `${st.name}　${st.date}`;
    if (st.done) return say('✅ 今天已完成點名', 'okk');
    if (st.rejected) say('⚠️ 您的點名照片被老師退回，請重新拍照；有疑問請洽老師', 'err');
    else if (!st.open) return say(st.reason, 'info');
    else say('請拍照完成點名', 'info');
    $('shotCard').hidden = false;
  }

  $('loginBtn').onclick = async () => {
    try {
      await api('/api/action', { action: 'login-student', courseId, name: $('name').value.trim(), password: $('pw').value.trim() });
      await refresh();
    } catch (e) { say(e.message, 'err'); }
  };

  $('startBtn').onclick = async () => {
    try {
      challenge = await api('/api/checkin/challenge', {});
      $('code').textContent = `驗證碼 ${challenge.code}`;
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      $('video').srcObject = stream;
      $('video').hidden = false; $('canvas').hidden = true;
      $('startBtn').hidden = true; $('snapBtn').hidden = false; $('retakeBtn').hidden = $('sendBtn').hidden = true;
      if (st.geo.required || navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(p => { pos = p.coords; }, () => { pos = null; }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
      }
    } catch (e) {
      say(e.name === 'NotAllowedError' ? '請允許使用相機後重試' : (e.message || '無法開啟相機'), 'err');
    }
  };

  $('snapBtn').onclick = () => {
    const v = $('video'), c = $('canvas');
    const scale = Math.min(1, 960 / (v.videoWidth || 960));
    c.width = Math.round((v.videoWidth || 960) * scale); c.height = Math.round((v.videoHeight || 720) * scale);
    const g = c.getContext('2d');
    g.drawImage(v, 0, 0, c.width, c.height);
    const stamp = `${st.name}  ${new Date(challenge.issuedAt).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' })}  驗證碼 ${challenge.code}`;
    g.font = `bold ${Math.round(c.width / 22)}px sans-serif`;
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, c.height - c.width / 14, c.width, c.width / 14);
    g.fillStyle = '#fff'; g.fillText(stamp, 10, c.height - c.width / 40);
    photo = c.toDataURL('image/jpeg', 0.7);
    stopCam();
    $('video').hidden = true; c.hidden = false;
    $('snapBtn').hidden = true; $('retakeBtn').hidden = $('sendBtn').hidden = false;
  };

  $('retakeBtn').onclick = () => { photo = ''; $('canvas').hidden = true; $('retakeBtn').hidden = $('sendBtn').hidden = true; $('startBtn').hidden = false; $('code').textContent = ''; };

  $('sendBtn').onclick = async () => {
    $('sendBtn').disabled = true;
    try {
      await api('/api/checkin/submit', {
        token: challenge.token, photo, deviceId,
        lat: pos ? pos.latitude : null, lng: pos ? pos.longitude : null, accuracy: pos ? pos.accuracy : null,
      });
      await refresh();
    } catch (e) {
      say(e.message, 'err');
      $('sendBtn').disabled = false;
    }
  };

  refresh();
})();
