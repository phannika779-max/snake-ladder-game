(function(){
  "use strict";

  /* ============ FIREBASE CONFIG ============ */
  /* แก้ค่าด้านล่างนี้ให้เป็นของโปรเจกต์ Firebase ของคุณเอง
     (Firebase Console > Project settings > General > Your apps > SDK setup and configuration) */
  var firebaseConfig = {
    apiKey: "AIzaSyD-r5YTYtBFzBt5iYzrE3v9rlqQQlfmTXQ",
    authDomain: "snake-ladder-game-797da.firebaseapp.com",
    databaseURL: "https://snake-ladder-game-797da-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "snake-ladder-game-797da",
    storageBucket: "snake-ladder-game-797da.firebasestorage.app",
    messagingSenderId: "444028723937",
    appId: "1:444028723937:web:fa21e0c3f4147c91754da0"
  };

  var db = null;
  var auth = null;

  function isConfigured(){
    return firebaseConfig.apiKey && firebaseConfig.apiKey.indexOf('YOUR_') !== 0 &&
           firebaseConfig.databaseURL && firebaseConfig.databaseURL.indexOf('YOUR_') === -1;
  }

  /* ============ CONSTANTS ============ */
  var LADDERS = {4:8, 5:17, 6:25, 7:34, 10:24, 11:32, 12:17, 18:32, 19:25, 23:32};    // bottom -> top (10 ladders = 10 question cells)
  var SNAKES  = {13:1, 14:2, 20:2, 22:1, 26:16, 28:1, 29:8, 30:1, 31:8, 35:17};       // head -> tail (10 snakes = 10 question cells)
  var BONUS   = {2:'extra', 16:'mystery', 24:'swap', 32:'mystery'};                   // รวม 20 ช่องคำถาม (10 บันได+10 งู) + 4 ช่องโบนัส + ช่องปกติที่เหลือ จาก 36 ช่อง
  var AVATARS = ['🐘','🐯','🦁','🐼','🐵','🐸','🦉','🐢','🦚','🐆'];
  var TOKEN_COLORS = ['#FFDB6B','#21B6B6','#FF6B5B','#B06FD6','#7ED957','#FF9F43','#5AD1FF','#F06FA0'];
  var SESSION_KEY = 'sl_session_v1';

  // ตัวแปรเก็บ Avatar ที่เลือกปัจจุบัน
var selectedAvatar = AVATARS[0]; // ค่าเริ่มต้นเป็นตัวแรก (🐘)

function selectAvatar(avatar) {
  // 1. อ่านค่าปัจจุบันในช่อง input เก็บไว้ก่อน
  var roomInput = document.getElementById('inputRoomCode') || document.querySelector('input[placeholder*="ห้อง"]');
  var nameInput = document.getElementById('inputPlayerName') || document.querySelector('input[placeholder*="ชื่อ"]');
  
  var currentRoom = roomInput ? roomInput.value : '';
  var currentName = nameInput ? nameInput.value : '';

  // 2. อัปเดตตัวแปร Avatar ที่เลือก
  selectedAvatar = avatar;

  // 3. ปรับสไตล์ปุ่มโดยไม่ Re-render หน้าจอใหม่ (ป้องกัน Input หาย 100%)
  var buttons = document.querySelectorAll('.avatar-btn, [data-avatar]');
  if (buttons.length > 0) {
    buttons.forEach(function(btn) {
      var btnText = btn.innerText || btn.getAttribute('data-avatar');
      if (btnText.indexOf(avatar) !== -1) {
        btn.style.border = '2px solid #21B6B6';
        btn.style.transform = 'scale(1.2)';
        btn.style.background = '#e6f7f7';
      } else {
        btn.style.border = '1px solid #ccc';
        btn.style.transform = 'scale(1)';
        btn.style.background = 'transparent';
      }
    });
  } else if (typeof render === 'function') {
    // กรณีที่ระบบบังคับ render ใหม่ ให้ส่งค่าเดิมกลับไปใส่
    render();
    var newRoomInput = document.getElementById('inputRoomCode') || document.querySelector('input[placeholder*="ห้อง"]');
    var newNameInput = document.getElementById('inputPlayerName') || document.querySelector('input[placeholder*="ชื่อ"]');
    if (newRoomInput) newRoomInput.value = currentRoom;
    if (newNameInput) newNameInput.value = currentName;
  }
}

  function cellPos(num){
    var rowFromBottom = Math.floor((num-1)/6);
    var posInRow = (num-1)%6;
    var col = (rowFromBottom % 2 === 0) ? posInRow : (5-posInRow);
    var row = 6 - rowFromBottom;
    return {row: row, col: col+1};
  }
  function cellType(num){
    if (num===36) return 'finish';
    if (LADDERS[num]) return 'ladder';
    if (SNAKES[num]) return 'snake';
    if (BONUS[num]) return 'bonus';
    return 'normal';
  }
  function cellIcon(num){
    var t = cellType(num);
    if (t==='ladder') return '🪜';
    if (t==='snake') return '🐍';
    if (t==='finish') return '🏆';
    if (t==='bonus') return BONUS[num]==='extra' ? '⭐' : (BONUS[num]==='mystery' ? '🎁' : '🔀');
    return '';
  }
  function cellDestLabel(num){
    if (LADDERS[num]) return '↑ ไปช่อง '+LADDERS[num];
    if (SNAKES[num]) return '↓ ตกช่อง '+SNAKES[num];
    return '';
  }

  /* ============ STATE ============ */
  var S = {
    booted: false,
    uid: null,
    role: null,          // 'host' | 'player'
    roomCode: null,
    playerId: null,
    room: null,
    roomListenerRef: null,
    draftQuestions: [],
    rollingAnim: false,
    lastAnswerResult: null,
    _pickedAvatar: null,
    _pendingJoinCode: null
  };

  function uid8(){ return Math.random().toString(36).slice(2,10); }
  function genCode(){
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    var c = '';
    for (var i=0;i<4;i++) c += chars[Math.floor(Math.random()*chars.length)];
    return c;
  }
  function joinLinkFor(code){
    return window.location.origin + window.location.pathname + '?room=' + encodeURIComponent(code);
  }

  function toast(msg, ms){
    var el = document.createElement('div');
    el.className = 'sl-toast';
    el.textContent = msg;
    document.getElementById('sl-toast-host').appendChild(el);
    setTimeout(function(){ el.remove(); }, ms||2200);
  }

  /* ============ SESSION PERSISTENCE (reconnect after refresh) ============ */
  function saveSession(){
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ role: S.role, roomCode: S.roomCode, playerId: S.playerId }));
    } catch(e){}
  }
  function clearSession(){
    try { localStorage.removeItem(SESSION_KEY); } catch(e){}
  }
  function loadSession(){
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch(e){ return null; }
  }

  /* ============ FIREBASE ROOM I/O ============ */
  function roomRefFor(code){ return db.ref('rooms/'+code); }

  async function saveRoom(room){
    S.room = room;
    var toWrite = JSON.parse(JSON.stringify(room));
    toWrite.updatedAt = firebase.database.ServerValue.TIMESTAMP;
    try {
      await roomRefFor(room.code).set(toWrite);
    } catch(e){ console.error('save failed', e); toast('บันทึกข้อมูลไม่สำเร็จ: '+(e && e.message ? e.message : 'unknown error')); }
    render();
  }

  async function loadRoomOnce(code){
    try {
      var snap = await roomRefFor(code).once('value');
      return snap.exists() ? normalizeRoom(snap.val()) : null;
    } catch(e){ console.error('load failed', e); return null; }
  }

  function normalizeRoom(val){
    if (!val) return val;
    if (!val.players) val.players = [];
    if (!val.questions) val.questions = [];
    if (!val.turn) val.turn = { currentPlayerIndex:0, phase:'awaiting_roll', log:[] };
    if (!val.turn.log) val.turn.log = [];
    if (typeof val.questionIndex !== 'number') val.questionIndex = 0;
    return val;
  }

  function attachRoomListener(code){
    detachRoomListener();
    S.roomListenerRef = roomRefFor(code);
    S.roomListenerRef.on('value', function(snap){
      var val = snap.val();
      if (val){
        S.room = normalizeRoom(val);
        render();
      } else if (S.room) {
        // room was deleted
        toast('ห้องนี้ถูกปิดไปแล้ว');
        resetToHome();
      }
    }, function(err){
      console.error('listener error', err);
      toast('การเชื่อมต่อขาดหาย: '+(err && err.message ? err.message : ''));
    });
  }
  function detachRoomListener(){
    if (S.roomListenerRef){ S.roomListenerRef.off(); S.roomListenerRef = null; }
  }

  /* ============ GAME LOGIC ============ */
  function currentPlayer(room){ return room.players[room.turn.currentPlayerIndex]; }

  function nextTurn(room){
    if (room.players.length===0) return;
    room.turn.currentPlayerIndex = (room.turn.currentPlayerIndex+1) % room.players.length;
    room.turn.phase = 'awaiting_roll';
    room.turn.lastRoll = null;
    room.turn.activeQuestion = null;
  }

  function pushLog(room, msg){
    room.turn.log = room.turn.log || [];
    room.turn.log.unshift(msg);
    if (room.turn.log.length>8) room.turn.log.length = 8;
  }

  function pickQuestion(room){
    var pool = room.questions;
    if (!pool || pool.length===0) return null;
    if (typeof room.questionIndex !== 'number') room.questionIndex = 0;
    var q = pool[room.questionIndex % pool.length];
    room.questionIndex = (room.questionIndex + 1) % pool.length;
    return q;
  }

  async function doRoll(){
    var room = S.room;
    var p = currentPlayer(room);
    if (!p || p.id !== S.playerId) return;
    if (room.turn.phase !== 'awaiting_roll') return;
    S.rollingAnim = true; render();
    await new Promise(function(res){ setTimeout(res, 480); });
    S.rollingAnim = false;

    var dice = 1 + Math.floor(Math.random()*6);
    var from = p.pos;
    var to = from + dice;
    room.turn.lastRoll = dice;

    if (to > 36){
      pushLog(room, p.avatar+' '+p.name+' ทอยได้ '+dice+' แต้ม แต่เกินช่อง 36 ขยับไม่ได้');
      toast(p.name+' ทอยได้ '+dice+' — เกินช่อง 36! อดขยับ 😅');
      nextTurn(room);
      await saveRoom(room);
      return;
    }

    p.pos = to;
    pushLog(room, p.avatar+' '+p.name+' ทอยได้ '+dice+' แต้ม เดินไปช่อง '+to);

    if (to===36){
      room.status = 'finished';
      room.winner = p.id;
      pushLog(room, '🏆 '+p.avatar+' '+p.name+' ถึงช่อง 36 เป็นผู้ชนะ!');
      await saveRoom(room);
      return;
    }

    var t = cellType(to);
    if (t==='ladder' || t==='snake'){
      var q = pickQuestion(room);
      if (q){
        room.turn.phase = 'awaiting_answer';
        room.turn.activeQuestion = { id: q.id, text: q.text, choices: q.choices, correct: q.correct, forPlayerId: p.id, effectCell: to, effectType: t };
        await saveRoom(room);
        return;
      } else {
        if (t==='ladder'){ p.pos = LADDERS[to]; pushLog(room,'🪜 ไม่มีคำถามในระบบ ขึ้นบันไดอัตโนมัติ ไปช่อง '+p.pos); }
        else { pushLog(room,'🐍 ไม่มีคำถามในระบบ รอดจากงูไปได้'); }
      }
    } else if (t==='bonus'){
      applyBonus(room, p, to);
    }

    if (room.turn.phase !== 'awaiting_answer'){
      if (!room.turn.skipAdvance) nextTurn(room);
      room.turn.skipAdvance = false;
    }
    await saveRoom(room);
  }

  function applyBonus(room, p, cell){
    var kind = BONUS[cell];
    if (kind==='extra'){
      pushLog(room, '⭐ '+p.avatar+' '+p.name+' เจอช่องดาว! ได้ทอยอีกครั้ง');
      toast(p.name+' เจอช่องดาว ⭐ ทอยต่อได้อีกตา!');
      room.turn.skipAdvance = true;
    } else if (kind==='mystery'){
      var effects = ['fwd3','back2','extraTurn','swapRandom'];
      var pick = effects[Math.floor(Math.random()*effects.length)];
      if (pick==='fwd3'){ p.pos = Math.min(35, p.pos+3); pushLog(room,'🎁 กล่องสุ่มให้โบนัส! เดินหน้า 3 ช่อง ไปช่อง '+p.pos); toast('🎁 จุ่มโดนของดี! เดินหน้า 3 ช่อง'); }
      else if (pick==='back2'){ p.pos = Math.max(0, p.pos-2); pushLog(room,'🎁 กล่องสุ่มแกล้ง! ถอยหลัง 2 ช่อง ไปช่อง '+p.pos); toast('🎁 จุ่มโดนของแกล้ง! ถอยหลัง 2 ช่อง'); }
      else if (pick==='extraTurn'){ pushLog(room,'🎁 กล่องสุ่มให้ตาพิเศษ! ทอยต่อได้อีกครั้ง'); toast('🎁 จุ่มโดนตาพิเศษ! ทอยอีกครั้ง'); room.turn.skipAdvance = true; }
      else {
        var others = room.players.filter(function(x){ return x.id!==p.id; });
        if (others.length){
          var target = others[Math.floor(Math.random()*others.length)];
          var tmp = p.pos; p.pos = target.pos; target.pos = tmp;
          pushLog(room, '🎁 กล่องสุ่ม! สลับตำแหน่งกับ '+target.avatar+' '+target.name);
          toast('🎁 จุ่มโดนสลับตำแหน่งกับ '+target.name+'!');
        }
      }
    } else if (kind==='swap'){
      var others2 = room.players.filter(function(x){ return x.id!==p.id; });
      if (others2.length){
        var t2 = others2[Math.floor(Math.random()*others2.length)];
        var tmp2 = p.pos; p.pos = t2.pos; t2.pos = tmp2;
        pushLog(room, '🔀 '+p.name+' เหยียบช่องสลับตำแหน่ง! สลับกับ '+t2.avatar+' '+t2.name);
        toast('🔀 สลับตำแหน่งกับ '+t2.name+'!');
      }
    }
  }

  async function submitAnswer(choiceIdx){
    var room = S.room;
    var aq = room.turn.activeQuestion;
    if (!aq || aq.forPlayerId !== S.playerId) return;
    var p = room.players.find(function(x){ return x.id===S.playerId; });
    var correct = choiceIdx === aq.correct;

    S.lastAnswerResult = { choiceIdx: choiceIdx, correct: correct };
    render();
    await new Promise(function(res){ setTimeout(res, 900); });
    S.lastAnswerResult = null;

    if (aq.effectType==='ladder'){
      if (correct){ p.pos = LADDERS[aq.effectCell]; pushLog(room, '✅ '+p.name+' ตอบถูก! ขึ้นบันได ไปช่อง '+p.pos); toast('✅ ตอบถูก! ขึ้นบันไดไปช่อง '+p.pos); }
      else { pushLog(room, '❌ '+p.name+' ตอบผิด อดขึ้นบันได อยู่ช่องเดิม '+p.pos); toast('❌ ตอบผิด อดขึ้นบันได'); }
    } else {
      if (correct){ pushLog(room, '✅ '+p.name+' ตอบถูก! รอดจากงูกัด อยู่ช่อง '+p.pos); toast('✅ ตอบถูก! ไม่โดนงูกัด'); }
      else { p.pos = SNAKES[aq.effectCell]; pushLog(room, '❌ '+p.name+' ตอบผิด โดนงูกัด ตกไปช่อง '+p.pos); toast('❌ ตอบผิด โดนงูกัด! ตกไปช่อง '+p.pos); }
    }

    if (p.pos===36){
      room.status='finished'; room.winner=p.id;
      pushLog(room,'🏆 '+p.avatar+' '+p.name+' ถึงช่อง 36 เป็นผู้ชนะ!');
    } else {
      nextTurn(room);
    }
    await saveRoom(room);
  }

  /* ============ ACTIONS ============ */
  async function createRoom(){
    if (S.draftQuestions.length===0){ toast('กรุณาเพิ่มคำถามอย่างน้อย 1 ข้อก่อนสร้างห้อง'); return; }
    var code = genCode();
    var existing = await loadRoomOnce(code);
    var attempts = 0;
    while (existing && attempts<5){ code = genCode(); existing = await loadRoomOnce(code); attempts++; }
    var room = {
      code: code, createdAt: Date.now(), status: 'lobby',
      questions: S.draftQuestions, questionIndex: 0,
      players: [],
      turn: { currentPlayerIndex: 0, phase: 'awaiting_roll', lastRoll: null, activeQuestion: null, log: [], skipAdvance:false },
      winner: null, hostUid: S.uid
    };
    S.roomCode = code; S.role='host'; S.playerId = null;
    await saveRoom(room);
    attachRoomListener(code);
    saveSession();
    setTimeout(renderQR, 60);
  }

  async function joinRoom(code, name, avatar){
    code = (code||'').toUpperCase().trim();
    if (code.length<4){ toast('กรอกรหัสห้อง 4 ตัวอักษร'); return; }
    if (!name.trim()){ toast('กรอกชื่อผู้เล่น'); return; }
    var snap;
    try { snap = await roomRefFor(code).once('value'); }
    catch(e){ toast('เชื่อมต่อไม่สำเร็จ: '+(e&&e.message?e.message:'')); return; }
    if (!snap.exists()){ toast('ไม่พบห้องนี้ ตรวจสอบรหัสอีกครั้ง'); return; }
    var room0 = normalizeRoom(snap.val());
    if (room0.status!=='lobby'){ toast('ห้องนี้เริ่มเกมไปแล้ว'); return; }

    var newPlayer = { id: S.uid, name: name.trim().slice(0,16), avatar: avatar, pos: 0 };
    var playersRef = roomRefFor(code).child('players');
    try {
      await playersRef.transaction(function(current){
        var arr = current || [];
        if (!Array.isArray(arr)) { // Firebase may return an object map if sparse
          arr = Object.keys(arr).sort().map(function(k){ return arr[k]; });
        }
        var already = arr.some(function(x){ return x && x.id===S.uid; });
        if (!already) arr.push(newPlayer);
        return arr;
      });
    } catch(e){ toast('เข้าร่วมห้องไม่สำเร็จ: '+(e&&e.message?e.message:'')); return; }

    S.roomCode = code; S.playerId = S.uid; S.role = 'player';
    attachRoomListener(code);
    saveSession();
  }

  async function startGame(){
    var room = S.room;
    if (room.players.length===0){ toast('ต้องมีผู้เล่นอย่างน้อย 1 คน'); return; }
    room.status = 'playing';
    room.turn = { currentPlayerIndex: 0, phase: 'awaiting_roll', lastRoll: null, activeQuestion: null, log: ['🎮 เริ่มเกม! ตาของ '+room.players[0].avatar+' '+room.players[0].name], skipAdvance:false };
    await saveRoom(room);
  }

  async function playAgain(){
    var room = S.room;
    room.players.forEach(function(p){ p.pos = 0; });
    room.status = 'lobby';
    room.winner = null;
    room.questionIndex = 0;
    room.turn = { currentPlayerIndex: 0, phase: 'awaiting_roll', lastRoll: null, activeQuestion: null, log: [], skipAdvance:false };
    await saveRoom(room);
  }

  function resetToHome(){
    detachRoomListener();
    clearSession();
    S.role=null; S.roomCode=null; S.playerId=null; S.room=null; S.draftQuestions=[]; S._pendingJoinCode=null;
    render();
  }

  /* ============ RENDER: SHARED PIECES ============ */
  function renderBoardHTML(room){
    var cells = '';
    for (var n=1;n<=36;n++){
      var t = cellType(n);
      var altClass = (Math.floor((n-1)/6)%2===0 ? (n%2===0?'alt':'') : (n%2===1?'alt':''));
      var pos = cellPos(n);
      var players = room.players.filter(function(p){ return p.pos===n; });
      var tokensHtml = players.map(function(p){
        var color = TOKEN_COLORS[room.players.indexOf(p)%TOKEN_COLORS.length];
        return '<span class="sl-token" style="background:'+color+'" title="'+p.name+'">'+p.avatar+'</span>';
      }).join('');
      var destLabel = cellDestLabel(n);
      cells += '<div class="sl-cell '+t+' '+altClass+'" style="grid-row:'+pos.row+';grid-column:'+pos.col+'">'+
                n+
                '<span class="sl-cell-icon">'+cellIcon(n)+'</span>'+
                (destLabel ? '<span class="sl-cell-dest">'+destLabel+'</span>' : '') +
                '<div class="sl-tokens">'+tokensHtml+'</div>'+
                '</div>';
    }
    return '<div class="sl-board-outer"><div class="sl-board" id="sl-board">'+cells+'<svg id="sl-svg-overlay"></svg></div></div>';
  }

  function drawOverlay(){
    var board = document.getElementById('sl-board');
    var svg = document.getElementById('sl-svg-overlay');
    if (!board || !svg) return;
    var bRect = board.getBoundingClientRect();
    var svgns = 'http://www.w3.org/2000/svg';
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute('viewBox','0 0 '+bRect.width+' '+bRect.height);
    // ไม่วาดเส้นบันได/ตัวงูยาวพาดกระดานแล้ว — ใช้แค่ไอคอน 🪜🐍 มุมขวาล่าง
    // และป้ายบอกช่องปลายทางที่มุมขวาบนของแต่ละช่อง (ดู cellIcon / cellDestLabel)
  }

  function renderQR(){
    var host = document.getElementById('sl-qrcode');
    if (!host) return;
    host.innerHTML = '';
    var link = joinLinkFor(S.roomCode);
    try {
      var qr = qrcode(0, 'L');
      qr.addData(link);
      qr.make();
      var svgMarkup = qr.createSvgTag({ cellSize: 8, margin: 16 });
      host.innerHTML = svgMarkup;
      var svgEl = host.querySelector('svg');
      if (svgEl){
        svgEl.style.width = '208px'; svgEl.style.height = '208px'; svgEl.style.display='block'; svgEl.style.borderRadius='10px';
        svgEl.setAttribute('shape-rendering','crispEdges');
      }
    } catch(e){ host.innerHTML = '<div style="color:#C9C3AA;font-size:12px;max-width:170px">QR ไม่พร้อมใช้งาน — ใช้รหัสห้องด้านบนแทนได้เลย</div>'; }
  }

  async function copyLink(){
    var link = joinLinkFor(S.roomCode);
    try { await navigator.clipboard.writeText(link); toast('คัดลอกลิงก์แล้ว ✅'); }
    catch(e){
      var ta = document.createElement('textarea');
      ta.value = link; ta.style.position='fixed'; ta.style.opacity='0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('คัดลอกลิงก์แล้ว ✅'); }
      catch(e2){ toast('คัดลอกไม่สำเร็จ'); }
      ta.remove();
    }
  }

  /* ============ VIEWS ============ */
  function viewHome(){
    return '<div class="sl-wrap">' +
      '<span class="sl-eyebrow">🐍🪜 เกมกระดานคลาสสิก</span>' +
      '<h1 class="sl-title">บันไดงู ผจญภัย</h1>' +
      '<p class="sl-sub">ทอยลูกเต๋า ตอบคำถามให้ถูก หนีงู ไต่บันได ใครถึงช่อง 36 ก่อนชนะ! เล่นได้หลายคนพร้อมกันผ่านมือถือ เหมือนเล่น Kahoot — ไม่ต้องสมัครสมาชิก</p>' +
      '<div class="sl-role-grid">' +
        '<div class="sl-role-card">' +
          '<div class="sl-role-emoji">🖥️</div><h3>ผู้ดำเนินเกม (Host)</h3>' +
          '<p>ตั้งคำถาม สร้างห้อง แสดง QR code และกระดานเกมบนจอหลัก</p>' +
          '<button class="sl-btn sl-btn-gold sl-btn-block" data-act="go-host-setup">ตั้งค่าและสร้างห้อง</button>' +
        '</div>' +
        '<div class="sl-role-card">' +
          '<div class="sl-role-emoji">📱</div><h3>ผู้เล่น (Player)</h3>' +
          '<p>สแกน QR หรือกรอกรหัสห้องเพื่อเข้าร่วมเกมจากมือถือของคุณ</p>' +
          '<button class="sl-btn sl-btn-ghost sl-btn-block" data-act="go-player-join">เข้าร่วมเกม</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function viewHostSetup(){
    var list = S.draftQuestions.map(function(q,i){
      return '<div class="sl-qitem"><div class="sl-qitem-txt"><b>'+(i+1)+'. '+q.text+'</b>' +
        '<div class="sl-qitem-choices">'+q.choices.map(function(c,ci){ return (ci===q.correct?'✅ ':'• ')+c; }).join('&nbsp;&nbsp;')+'</div></div>' +
        '<button class="sl-del" data-act="del-q" data-idx="'+i+'">✕</button></div>';
    }).join('') || '<p class="sl-empty">ยังไม่มีคำถาม เพิ่มคำถามด้านล่างอย่างน้อย 1 ข้อ</p>';

    return '<div class="sl-wrap">' +
      '<span class="sl-eyebrow">ขั้นตอนที่ 1</span><h2 class="sl-title" style="font-size:26px">ตั้งคำถามของคุณ</h2>' +
      '<p class="sl-sub">คำถามเหล่านี้จะขึ้นตามลำดับที่ใส่ เมื่อผู้เล่นเหยียบช่องบันไดหรือช่องงู</p>' +
      '<div class="sl-card" style="margin-top:18px">' +
        '<label class="sl-label">คำถาม</label>' +
        '<input class="sl-input" id="q-text" placeholder="เช่น เมืองหลวงของประเทศไทยคือ?">' +
        '<div class="sl-choice-row">' +
          '<div class="sl-choice-cell"><input type="radio" name="q-correct" value="0" class="sl-radio" checked><input class="sl-input" id="q-c0" placeholder="ตัวเลือก 1"></div>' +
          '<div class="sl-choice-cell"><input type="radio" name="q-correct" value="1" class="sl-radio"><input class="sl-input" id="q-c1" placeholder="ตัวเลือก 2"></div>' +
          '<div class="sl-choice-cell"><input type="radio" name="q-correct" value="2" class="sl-radio"><input class="sl-input" id="q-c2" placeholder="ตัวเลือก 3 (ไม่บังคับ)"></div>' +
          '<div class="sl-choice-cell"><input type="radio" name="q-correct" value="3" class="sl-radio"><input class="sl-input" id="q-c3" placeholder="ตัวเลือก 4 (ไม่บังคับ)"></div>' +
        '</div>' +
        '<p style="font-size:12px;color:#8a8468;margin-top:8px">เลือกวงกลมหน้าตัวเลือกที่เป็นคำตอบที่ถูกต้อง</p>' +
        '<button class="sl-btn sl-btn-ghost" style="margin-top:10px" data-act="add-q">+ เพิ่มคำถามนี้</button>' +
      '</div>' +
      '<div style="margin-top:18px">'+list+'</div>' +
      '<div style="display:flex;gap:12px;margin-top:22px;flex-wrap:wrap">' +
        '<button class="sl-btn sl-btn-gold" data-act="create-room">สร้างห้อง →</button>' +
        '<button class="sl-btn sl-btn-ghost" data-act="home">← กลับ</button>' +
      '</div>' +
    '</div>';
  }

  function viewHostLobby(){
    var room = S.room;
    var chips = room.players.map(function(p){
      return '<div class="sl-player-chip"><span class="av">'+p.avatar+'</span>'+p.name+'</div>';
    }).join('') || '<span class="sl-empty">รอผู้เล่นเข้าร่วม...</span>';

    return '<div class="sl-wrap">' +
      '<span class="sl-eyebrow">ห้องพร้อมแล้ว</span><h2 class="sl-title" style="font-size:26px">ผู้เล่นสแกนเพื่อเข้าร่วม</h2>' +
      '<div class="sl-lobby-grid">' +
        '<div class="sl-card sl-code-box">' +
          '<div style="font-size:13px;color:#C9C3AA">รหัสห้อง</div>' +
          '<div class="sl-code mono">'+room.code+'</div>' +
          '<div id="sl-qrcode"></div>' +
          '<div style="font-size:12.5px;color:#8a8468">สแกน QR หรือส่งลิงก์นี้ให้เพื่อน</div>' +
          '<button class="sl-btn sl-btn-ghost sl-btn-block" style="margin-top:12px" data-act="copy-link">📋 คัดลอกลิงก์</button>' +
        '</div>' +
        '<div class="sl-card">' +
          '<div style="display:flex;justify-content:space-between;align-items:center">' +
            '<h3 style="margin:0;font-size:16px">ผู้เล่น ('+room.players.length+')</h3>' +
          '</div>' +
          '<div class="sl-player-list">'+chips+'</div>' +
          '<button class="sl-btn sl-btn-gold sl-btn-block" style="margin-top:20px" data-act="start-game" '+(room.players.length===0?'disabled':'')+'>เริ่มเกม 🎲</button>' +
          '<button class="sl-btn sl-btn-ghost sl-btn-block" style="margin-top:8px" data-act="home">ปิดห้อง</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function legendHTML(){
    return '<div class="sl-legend">' +
      '<span><span class="sl-dot" style="background:#F4E4A8"></span>🪜 ช่องบันได (คำถาม)</span>' +
      '<span><span class="sl-dot" style="background:#F0D3C8"></span>🐍 ช่องงู (คำถาม)</span>' +
      '<span><span class="sl-dot" style="background:#D6F7F5"></span>⭐🎁🔀 ช่องโบนัส</span>' +
      '<span><span class="sl-dot" style="background:linear-gradient(135deg,#FFDB6B,#FFC93C)"></span>🏆 ช่องชนะ</span>' +
      '<span>🔖 ตัวเลขบนป้ายในแต่ละช่อง = ช่องปลายทางที่จะไปถ้าตอบถูก/ผิด</span>' +
    '</div>';
  }

  function viewHostGame(){
    var room = S.room;
    if (room.status==='finished') return viewWin(true);
    var p = currentPlayer(room);
    var boardHtml = renderBoardHTML(room);
    var qHtml = '';
    if (room.turn.phase==='awaiting_answer' && room.turn.activeQuestion){
      var aq = room.turn.activeQuestion;
      qHtml = '<div class="sl-qmodal"><div class="sl-qtext">❓ '+aq.text+'</div>' +
        aq.choices.map(function(c){ return '<div class="sl-choice-btn" style="pointer-events:none;opacity:.85">'+c+'</div>'; }).join('') +
        '<p style="font-size:12.5px;color:#C9C3AA;margin-top:6px">รอ '+p.avatar+' '+p.name+' ตอบบนมือถือ...</p></div>';
    }
    return '<div class="sl-wrap">' +
      '<div class="sl-turn-banner">🎯 ตาของ: '+p.avatar+' <b>'+p.name+'</b>'+(room.turn.lastRoll?' — ทอยได้ '+room.turn.lastRoll:'')+'</div>' +
      '<div class="sl-game-grid">' +
        '<div>' + boardHtml + legendHTML() + '</div>' +
        '<div class="sl-card">' +
          '<h3 style="margin-top:0;font-size:16px">อันดับผู้เล่น</h3>' +
          '<div class="sl-standings">' + standingsHTML(room) + '</div>' +
          qHtml +
          '<h4 style="font-size:13px;color:#C9C3AA;margin-bottom:6px">เหตุการณ์ล่าสุด</h4>' +
          '<div class="sl-log">' + (room.turn.log||[]).map(function(l){ return '<div>'+l+'</div>'; }).join('') + '</div>' +
        '</div>' +
      '</div>' +
      '<button class="sl-btn sl-btn-ghost" style="margin-top:18px" data-act="home">ออกจากห้อง</button>' +
    '</div>';
  }

  function standingsHTML(room){
    var sorted = room.players.slice().sort(function(a,b){ return b.pos-a.pos; });
    return sorted.map(function(p){
      var active = room.status==='playing' && currentPlayer(room) && currentPlayer(room).id===p.id;
      return '<div class="sl-standing-row '+(active?'active':'')+'"><span class="sl-standing-pos">'+p.pos+'</span><span>'+p.avatar+'</span><span>'+p.name+'</span></div>';
    }).join('');
  }

function viewPlayerJoin(){
  // 1. อ่านค่าปัจจุบันจากช่องกรอกข้อมูลก่อน (ถ้ามีพิมพ์ค้างไว้)
  var codeEl = document.getElementById('pj-code');
  var nameEl = document.getElementById('pj-name');
  
  var currentCode = codeEl ? codeEl.value : (S._pendingJoinCode || '');
  var currentName = nameEl ? nameEl.value : '';

  // 2. สร้างปุ่มเลือก Avatar
  var avatars = AVATARS.map(function(a){
    return '<button class="sl-avatar-opt '+(S._pickedAvatar===a?'picked':'')+'" data-act="pick-avatar" data-av="'+a+'">'+a+'</button>';
  }).join('');

  // 3. นำค่า currentCode และ currentName ใส่คืนใน value="..." ของ input
  return '<div class="sl-wrap">' +
    '<span class="sl-eyebrow">เข้าร่วมเกม</span><h2 class="sl-title" style="font-size:26px">กรอกรหัสห้อง</h2>' +
    '<div class="sl-card" style="max-width:420px;margin-top:16px">' +
      '<label class="sl-label">รหัสห้อง (4 ตัวอักษร)</label>' +
      '<input class="sl-input mono" id="pj-code" placeholder="ABCD" maxlength="4" value="' + currentCode + '" style="text-transform:uppercase;font-size:22px;text-align:center;letter-spacing:0.2em">' +
      '<label class="sl-label" style="margin-top:14px">ชื่อของคุณ</label>' +
      '<input class="sl-input" id="pj-name" placeholder="ชื่อเล่น" maxlength="16" value="' + currentName + '">' +
      '<label class="sl-label" style="margin-top:14px">เลือกตัวละคร</label>' +
      '<div class="sl-avatar-grid">'+avatars+'</div>' +
      '<button class="sl-btn sl-btn-gold sl-btn-block" style="margin-top:18px" data-act="do-join">เข้าร่วมเกม</button>' +
      '<button class="sl-btn sl-btn-ghost sl-btn-block" style="margin-top:8px" data-act="home">← กลับ</button>' +
    '</div>' +
  '</div>';
}

  function viewPlayerGame(){
    var room = S.room;
    if (!room) return '<div class="sl-wrap"><p>กำลังโหลด...</p></div>';
    if (room.status==='finished') return viewWin(false);
    var me = room.players.find(function(x){ return x.id===S.playerId; });
    if (!me) return '<div class="sl-wrap"><p>ไม่พบข้อมูลผู้เล่น กรุณาเข้าร่วมใหม่</p><button class="sl-btn sl-btn-ghost" data-act="home">← กลับหน้าแรก</button></div>';

    if (room.status==='lobby'){
      return '<div class="sl-wrap">' +
        '<div class="sl-card" style="text-align:center;padding:36px 20px">' +
          '<div style="font-size:44px">'+me.avatar+'</div>' +
          '<h2 class="disp" style="margin:8px 0">สวัสดี, '+me.name+'!</h2>' +
          '<p class="sl-sub" style="margin:0 auto">รออยู่ในห้อง <b class="mono">'+room.code+'</b> — ผู้เล่นทั้งหมด '+room.players.length+' คน<br>รอโฮสต์เริ่มเกม...</p>' +
        '</div>' +
      '</div>';
    }

    var isMyTurn = currentPlayer(room) && currentPlayer(room).id===me.id;
    var body = '';
    if (room.turn.phase==='awaiting_answer' && room.turn.activeQuestion && room.turn.activeQuestion.forPlayerId===me.id){
      var aq = room.turn.activeQuestion;
      body = '<div class="sl-qmodal"><div class="sl-qtext">❓ '+aq.text+'</div>' +
        aq.choices.map(function(c,i){
          var cls = '';
          if (S.lastAnswerResult){
            if (i===aq.correct) cls = 'correct';
            else if (i===S.lastAnswerResult.choiceIdx && !S.lastAnswerResult.correct) cls='wrong';
          }
          return '<button class="sl-choice-btn '+cls+'" data-act="answer" data-i="'+i+'" '+(S.lastAnswerResult?'disabled':'')+'>'+c+'</button>';
        }).join('') +
      '</div>';
    } else if (room.turn.phase==='awaiting_answer'){
      body = '<div class="sl-card" style="text-align:center;padding:26px"><p>⏳ รอ '+currentPlayer(room).name+' ตอบคำถาม...</p></div>';
    } else if (isMyTurn){
      body = '<div class="sl-card" style="text-align:center;padding:26px">' +
        '<div class="sl-dice '+(S.rollingAnim?'rolling':'')+'">'+(room.turn.lastRoll&&!S.rollingAnim?room.turn.lastRoll:'🎲')+'</div>' +
        '<button class="sl-btn sl-btn-gold" style="margin-top:18px" data-act="roll" '+(S.rollingAnim?'disabled':'')+'>ทอยลูกเต๋า!</button>' +
      '</div>';
    } else {
      body = '<div class="sl-card" style="text-align:center;padding:26px"><p>⏳ รอตาของ '+(currentPlayer(room)?currentPlayer(room).avatar+' '+currentPlayer(room).name:'...')+'</p></div>';
    }

    return '<div class="sl-wrap">' +
      '<div class="sl-turn-banner">'+me.avatar+' คุณอยู่ที่ช่อง <b>&nbsp;'+me.pos+'&nbsp;</b> / 36</div>' +
      body +
      '<div class="sl-card" style="margin-top:14px"><h3 style="margin-top:0;font-size:15px">อันดับ</h3><div class="sl-standings">'+standingsHTML(room)+'</div></div>' +
      '<button class="sl-btn sl-btn-ghost sl-btn-block" style="margin-top:14px" data-act="home">ออกจากเกม</button>' +
    '</div>';
  }

  function viewWin(isHost){
    var room = S.room;
    var w = room.players.find(function(p){ return p.id===room.winner; });
    return '<div class="sl-wrap"><div class="sl-card sl-winbox">' +
      '<div class="emoji">🏆</div>' +
      '<h2 class="disp" style="font-size:28px">'+(w?w.avatar+' '+w.name:'ผู้เล่น')+' ชนะแล้ว!</h2>' +
      '<p class="sl-sub" style="margin:8px auto 0">ถึงช่อง 36 เป็นคนแรก</p>' +
      '<div class="sl-standings" style="max-width:340px;margin:18px auto 0;text-align:left">'+standingsHTML(room)+'</div>' +
      (isHost ? '<button class="sl-btn sl-btn-gold" style="margin-top:20px" data-act="play-again">เล่นอีกครั้ง (ห้องเดิม)</button>' : '<p style="margin-top:16px" class="sl-empty">รอโฮสต์เริ่มเกมใหม่...</p>') +
      '<div><span class="sl-backlink" data-act="home">← ออกจากเกม</span></div>' +
    '</div></div>';
  }

  function viewConfigNeeded(){
    return '<div class="sl-wrap"><div class="sl-card" style="max-width:600px;margin:20px auto">' +
      '<span class="sl-eyebrow">⚙️ ตั้งค่าที่จำเป็นก่อนใช้งาน</span>' +
      '<h2 class="sl-title" style="font-size:22px;margin-top:10px">ยังไม่ได้ใส่ค่า Firebase Config</h2>' +
      '<p class="sl-sub">เปิดไฟล์ <code>app.js</code> แล้วแก้ตัวแปร <code>firebaseConfig</code> ที่ด้านบนสุดของไฟล์ ให้เป็นค่าจากโปรเจกต์ Firebase ของคุณเอง (ดูขั้นตอนละเอียดใน README.md ที่แนบมาด้วย)</p>' +
      '<p class="sl-sub" style="margin-top:10px">สรุปสั้น ๆ: สร้างโปรเจกต์ที่ <b>console.firebase.google.com</b> → เปิด Authentication (Anonymous) → สร้าง Realtime Database → ไปที่ Project settings → Your apps → เพิ่ม Web app → คัดลอกค่า config มาวางแทนที่</p>' +
    '</div></div>';
  }

  function viewAuthError(msg){
    return '<div class="sl-wrap"><div class="sl-card" style="max-width:600px;margin:20px auto">' +
      '<span class="sl-eyebrow">⚠️ เชื่อมต่อไม่สำเร็จ</span>' +
      '<h2 class="sl-title" style="font-size:22px;margin-top:10px">ล็อกอินแบบไม่ระบุตัวตนไม่สำเร็จ</h2>' +
      '<p class="sl-sub">'+msg+'</p>' +
      '<p class="sl-sub" style="margin-top:10px">ตรวจสอบว่าเปิดใช้งาน <b>Anonymous</b> sign-in method ใน Firebase Console → Authentication → Sign-in method แล้วหรือยัง</p>' +
    '</div></div>';
  }

  /* ============ MAIN RENDER ============ */
  function render(){
    var app = document.getElementById('sl-app');
    var html = '';
    if (!isConfigured()){ html = viewConfigNeeded(); app.innerHTML = html; return; }
    if (!S.booted){ html = '<div class="sl-wrap"><p class="sl-sub">กำลังเชื่อมต่อ...</p></div>'; app.innerHTML = html; return; }

    if (S.role==='host'){
      if (!S.room) html = viewHostSetup();
      else if (S.room.status==='lobby') html = viewHostLobby();
      else html = viewHostGame();
    } else if (S.role==='player'){
      if (S.roomCode && S.playerId) html = viewPlayerGame();
      else html = viewPlayerJoin();
    } else {
      html = viewHome();
    }
    app.innerHTML = html;

    if (S.role==='host' && S.room && S.room.status==='lobby'){ setTimeout(renderQR, 30); }
    if (S.role==='host' && S.room && S.room.status==='playing'){ setTimeout(drawOverlay, 30); }
  }

  /* ============ EVENTS ============ */
  document.getElementById('sl-root').addEventListener('click', function(ev){
    var t = ev.target.closest('[data-act]');
    if (!t) return;
    var act = t.getAttribute('data-act');

    if (act==='go-host-setup'){ S.role='host'; S.room=null; S.draftQuestions=[]; render(); }
    else if (act==='go-player-join'){ S.role='player'; S.roomCode=null; S.playerId=null; render(); }
    else if (act==='home'){ resetToHome(); }
    else if (act==='add-q'){
      var text = document.getElementById('q-text').value.trim();
      var c0 = document.getElementById('q-c0').value.trim();
      var c1 = document.getElementById('q-c1').value.trim();
      var c2 = document.getElementById('q-c2').value.trim();
      var c3 = document.getElementById('q-c3').value.trim();
      var correctRadio = document.querySelector('input[name="q-correct"]:checked');
      var correct = correctRadio ? parseInt(correctRadio.value) : 0;
      var choices = [c0,c1,c2,c3].filter(function(c){ return c.length>0; });
      if (!text || choices.length<2){ toast('กรอกคำถามและตัวเลือกอย่างน้อย 2 ข้อ'); return; }
      if (correct >= choices.length) correct = 0;
      S.draftQuestions.push({ id: uid8(), text: text, choices: choices, correct: correct });
      render();
    }
    else if (act==='del-q'){
      var idx = parseInt(t.getAttribute('data-idx'));
      S.draftQuestions.splice(idx,1);
      render();
    }
    else if (act==='create-room'){ createRoom(); }
    else if (act==='start-game'){ startGame(); }
    else if (act==='play-again'){ playAgain(); }
    else if (act==='copy-link'){ copyLink(); }
    else if (act==='pick-avatar'){ S._pickedAvatar = t.getAttribute('data-av'); render(); }
    else if (act==='do-join'){
      var code = document.getElementById('pj-code').value;
      var name = document.getElementById('pj-name').value;
      var av = S._pickedAvatar || AVATARS[Math.floor(Math.random()*AVATARS.length)];
      joinRoom(code, name, av);
    }
    else if (act==='roll'){ doRoll(); }
    else if (act==='answer'){ submitAnswer(parseInt(t.getAttribute('data-i'))); }
  });

  window.addEventListener('resize', function(){ if (S.role==='host') drawOverlay(); });

  /* ============ BOOT ============ */
  async function boot(){
    S.booted = true;

    // ถ้าลิงก์/QR มี ?room=CODE แปลว่าเข้ามาจากการแชร์ห้อง — พาไปหน้าร่วมเกมเลย พร้อมกรอกรหัสให้อัตโนมัติ
    var urlParams = new URLSearchParams(window.location.search);
    var roomFromUrl = (urlParams.get('room') || '').toUpperCase().trim();

    var session = loadSession();

    // ถ้ารหัสห้องจาก URL ไม่ตรงกับห้องเดิมที่เคยค้าง session ไว้ (เช่น สแกน QR ห้องใหม่ทั้งที่เคยเข้าห้องเก่ามาก่อน)
    // ให้ล้าง session เก่าทิ้งก่อน จะได้ไม่ถูกดึงกลับไปห้องเก่าโดยอัตโนมัติ
    if (roomFromUrl && session && session.roomCode !== roomFromUrl){
      clearSession();
      session = null;
    }

    if (session && session.roomCode){
      var room = await loadRoomOnce(session.roomCode);
      if (room && (session.role!=='player' || room.players.some(function(p){ return p.id===session.playerId; }))){
        S.role = session.role; S.roomCode = session.roomCode; S.playerId = session.playerId; S.room = room;
        attachRoomListener(session.roomCode);
        render();
        return;
      } else {
        clearSession();
      }
    }

    if (roomFromUrl){
      S._pendingJoinCode = roomFromUrl;
      S.role = 'player';
      S.roomCode = null;
      S.playerId = null;
    }

    render();
  }

  function initFirebase(){
    if (!isConfigured()){ render(); return; }
    try {
      firebase.initializeApp(firebaseConfig);
      db = firebase.database();
      auth = firebase.auth();
    } catch(e){ console.error(e); render(); return; }

    auth.onAuthStateChanged(function(user){
      if (user){
        S.uid = user.uid;
        boot();
      }
    });
    auth.signInAnonymously().catch(function(err){
      console.error('anon auth failed', err);
      document.getElementById('sl-app').innerHTML = viewAuthError((err && err.message) ? err.message : 'unknown error');
    });
  }

  render(); // initial paint (loading / config-needed state)
  initFirebase();
})();
