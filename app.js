(function(){
  "use strict";

  /* ============ FIREBASE CONFIG ============ */
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
  // บันไดและงูที่สมดุลแล้ว ไม่ข้ามไกลเกินไป
  var LADDERS = {3:11, 5:15, 8:14, 10:22, 16:23, 19:27, 21:28, 25:32, 29:33, 30:35};
  var SNAKES  = {9:2, 13:4, 17:7, 20:11, 24:15, 26:18, 31:22, 33:27, 34:16, 35:23};
  var BONUS   = {2:'extra', 12:'mystery', 18:'mystery', 28:'mystery'};
  var AVATARS = ['🐘','🐯','🦁','🐼','🐵','🐸','🦉','🐢','🦚','🐆'];
  var TOKEN_COLORS = ['#FFDB6B','#21B6B6','#FF6B5B','#B06FD6','#7ED957','#FF9F43','#5AD1FF','#F06FA0'];
  var SESSION_KEY = 'sl_session_v2';
  var QUESTION_TIME_LIMIT = 15; // เวลาตอบคำถาม 15 วินาทีต่อรอบ

  var timerInterval = null;

  /* ============ HELPERS ============ */
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
    if (t==='bonus') return BONUS[num]==='extra' ? '⭐' : '🎁';
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
    _pickedAvatar: AVATARS[0],
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
    var host = document.getElementById('sl-toast-host') || document.body;
    host.appendChild(el);
    setTimeout(function(){ el.remove(); }, ms||2200);
  }

  /* ============ SESSION PERSISTENCE ============ */
  function saveSession(){
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ role: S.role, roomCode: S.roomCode, playerId: S.playerId })); } catch(e){}
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

  /* ============ FIREBASE DB I/O ============ */
  function roomRefFor(code){ return db.ref('rooms/'+code); }

  async function saveRoom(room){
    S.room = room;
    var toWrite = JSON.parse(JSON.stringify(room));
    toWrite.updatedAt = firebase.database.ServerValue.TIMESTAMP;
    try {
      await roomRefFor(room.code).set(toWrite);
    } catch(e){ console.error('save failed', e); toast('บันทึกข้อมูลไม่สำเร็จ'); }
    render();
  }

  async function loadRoomOnce(code){
    try {
      var snap = await roomRefFor(code).once('value');
      return snap.exists() ? normalizeRoom(snap.val()) : null;
    } catch(e){ return null; }
  }

  function normalizeRoom(val){
    if (!val) return val;
    if (!val.players) val.players = [];
    if (!val.questions) val.questions = [];
    if (!val.round) val.round = { state: 'waiting', question: null, timer: 0, log: [] };
    if (!val.round.answers) val.round.answers = {};
    if (!val.round.lastResults) val.round.lastResults = {};
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
        toast('ห้องนี้ถูกปิดไปแล้ว');
        resetToHome();
      }
    });
  }
  function detachRoomListener(){
    if (S.roomListenerRef){ S.roomListenerRef.off(); S.roomListenerRef = null; }
  }

  /* ============ MASS MULTIPLAYER GAME LOGIC ============ */
  function pushLog(room, msg){
    room.round.log = room.round.log || [];
    room.round.log.unshift(msg);
    if (room.round.log.length > 8) room.round.log.length = 8;
  }

  // โฮสต์สั่งเปิดคำถามข้อต่อไป
  async function nextQuestionRound(){
    var room = S.room;
    if (room.questions.length === 0) return;

    if (typeof room.questionIndex !== 'number') room.questionIndex = 0;
    var q = room.questions[room.questionIndex % room.questions.length];
    room.questionIndex = (room.questionIndex + 1) % room.questions.length;

    room.round.state = 'answering';
    room.round.question = q;
    room.round.answers = {};
    room.round.lastResults = {};
    room.round.timer = QUESTION_TIME_LIMIT;
    
    await saveRoom(room);
    startHostTimer();
  }

  // ตัวนับเวลาเฉพาะฝั่ง Host
  function startHostTimer(){
    clearInterval(timerInterval);
    timerInterval = setInterval(async function(){
      if (!S.room || S.role !== 'host' || S.room.round.state !== 'answering') {
        clearInterval(timerInterval);
        return;
      }
      S.room.round.timer--;
      if (S.room.round.timer <= 0) {
        clearInterval(timerInterval);
        await processRoundResults();
      } else {
        // อัปเดตเฉพาะเวลาลง DB
        db.ref('rooms/' + S.room.code + '/round/timer').set(S.room.round.timer);
      }
    }, 1000);
  }

  // ประมวลผลคำตอบเมื่อหมดเวลา
  async function processRoundResults(){
    var room = S.room;
    var q = room.round.question;
    var answers = room.round.answers || {};
    var results = {};
    var winners = [];

    room.players.forEach(function(p){
      var playerAns = answers[p.id];
      var isCorrect = (playerAns === q.correct);
      var moveDist = 0;
      var oldPos = p.pos;

      if (isCorrect){
        // ตอบถูก: ทอยเต๋าสุ่มเดิน 1-6
        var dice = 1 + Math.floor(Math.random() * 6);
        var target = p.pos + dice;

        if (target > 36){
          // เกิน 36 ไม่ขยับ
          results[p.id] = { correct: true, dice: dice, msg: 'ทอยได้ ' + dice + ' (เกินช่อง 36 อยู่ที่เดิม)' };
        } else {
          p.pos = target;
          // เช็กว่าตกบันไดหรืองูไหม
          if (LADDERS[p.pos]){
            p.pos = LADDERS[p.pos];
            results[p.id] = { correct: true, dice: dice, msg: 'ทอยได้ ' + dice + ' 🪜 ขึ้นบันไดไปช่อง ' + p.pos };
          } else if (SNAKES[p.pos]){
            p.pos = SNAKES[p.pos];
            results[p.id] = { correct: true, dice: dice, msg: 'ทอยได้ ' + dice + ' 🐍 แต่โดนงูดัก ตกไปช่อง ' + p.pos };
          } else {
            results[p.id] = { correct: true, dice: dice, msg: 'ทอยได้ ' + dice + ' เดินไปช่อง ' + p.pos };
          }
        }
      } else {
        // ตอบผิด หรือ ตอบไม่ทัน
        if (SNAKES[p.pos]){
          p.pos = SNAKES[p.pos];
          results[p.id] = { correct: false, msg: 'ตอบผิด/ไม่ทัน 🐍 โดนงูกัด ตกไปช่อง ' + p.pos };
        } else {
          results[p.id] = { correct: false, msg: 'ตอบผิด/ไม่ทัน อยู่ที่ช่องเดิม (' + p.pos + ')' };
        }
      }

      if (p.pos === 36){
        winners.push(p);
      }
    });

    room.round.state = 'result';
    room.round.lastResults = results;

    if (winners.length > 0){
      room.status = 'finished';
      room.winner = winners.map(function(w){ return w.name; }).join(', ');
      pushLog(room, '🏆 มีผู้ชนะถึงช่อง 36 ได้แก่: ' + room.winner);
    } else {
      pushLog(room, '📢 ประมวลผลรอบคำถามเรียบร้อย!');
    }

    await saveRoom(room);
  }

  // ผู้เล่นส่งคำตอบ
  async function submitAnswer(choiceIdx){
    if (!S.room || S.room.round.state !== 'answering') return;
    var ref = db.ref('rooms/' + S.room.code + '/round/answers/' + S.playerId);
    await ref.set(choiceIdx);
    toast('บันทึกคำตอบแล้ว 👍');
  }

  /* ============ ACTIONS ============ */
  async function createRoom(){
    if (S.draftQuestions.length === 0){ toast('กรุณาเพิ่มคำถามอย่างน้อย 1 ข้อ'); return; }
    var code = genCode();
    var room = {
      code: code, createdAt: Date.now(), status: 'lobby',
      questions: S.draftQuestions, questionIndex: 0,
      players: [],
      round: { state: 'waiting', question: null, timer: 0, log: [], answers: {}, lastResults: {} },
      winner: null, hostUid: S.uid
    };
    S.roomCode = code; S.role = 'host'; S.playerId = null;
    await saveRoom(room);
    attachRoomListener(code);
    saveSession();
    setTimeout(renderQR, 60);
  }

  async function joinRoom(code, name, avatar){
    code = (code||'').toUpperCase().trim();
    if (code.length<4){ toast('กรอกรหัสห้อง 4 ตัวอักษร'); return; }
    if (!name.trim()){ toast('กรอกชื่อผู้เล่น'); return; }

    var snap = await roomRefFor(code).once('value');
    if (!snap.exists()){ toast('ไม่พบห้องนี้'); return; }
    var room0 = normalizeRoom(snap.val());

    var newPlayer = { id: S.uid, name: name.trim().slice(0,12), avatar: avatar, pos: 1 };
    var playersRef = roomRefFor(code).child('players');
    
    await playersRef.transaction(function(arr){
      arr = arr || [];
      if (!Array.isArray(arr)) arr = Object.keys(arr).map(function(k){ return arr[k]; });
      if (!arr.some(function(x){ return x && x.id === S.uid; })) arr.push(newPlayer);
      return arr;
    });

    S.roomCode = code; S.playerId = S.uid; S.role = 'player';
    attachRoomListener(code);
    saveSession();
  }

  async function startGame(){
    var room = S.room;
    if (room.players.length === 0){ toast('ต้องมีผู้เล่นอย่างน้อย 1 คน'); return; }
    room.status = 'playing';
    pushLog(room, '🎮 เริ่มเกมแล้ว! เตรียมตอบคำถามพร้อมกัน');
    await saveRoom(room);
    nextQuestionRound();
  }

  async function playAgain(){
    var room = S.room;
    room.players.forEach(function(p){ p.pos = 1; });
    room.status = 'lobby';
    room.winner = null;
    room.questionIndex = 0;
    room.round = { state: 'waiting', question: null, timer: 0, log: [], answers: {}, lastResults: {} };
    await saveRoom(room);
  }

  function resetToHome(){
    clearInterval(timerInterval);
    detachRoomListener();
    clearSession();
    S.role=null; S.roomCode=null; S.playerId=null; S.room=null; S.draftQuestions=[]; S._pendingJoinCode=null;
    render();
  }

  /* ============ UI RENDER (Mass Multiplayer Grid Optimization) ============ */
  function renderBoardHTML(room){
    var cells = '';
    for (var n=1; n<=36; n++){
      var t = cellType(n);
      var altClass = (Math.floor((n-1)/6)%2===0 ? (n%2===0?'alt':'') : (n%2===1?'alt':''));
      var pos = cellPos(n);
      var playersInCell = room.players.filter(function(p){ return p.pos === n; });

      // การแสดงผลผู้เล่นจำนวนมากบนกระดาน (Group Badges)
      var tokensHtml = '';
      if (playersInCell.length > 0) {
        if (playersInCell.length <= 3) {
          tokensHtml = playersInCell.map(function(p){
            return '<span class="sl-token" title="'+p.name+'">'+p.avatar+'</span>';
          }).join('');
        } else {
          // ถ้าเกิน 3 คนในช่องเดียว ให้แสดงเป็นกลุ่มตัวเลขรวม
          tokensHtml = '<span class="sl-token-group">👥 ' + playersInCell.length + '</span>';
        }
      }

      cells += '<div class="sl-cell '+t+' '+altClass+'" style="grid-row:'+pos.row+';grid-column:'+pos.col+'">'+
                '<span class="sl-cell-num">'+n+'</span>'+
                '<span class="sl-cell-icon">'+cellIcon(n)+'</span>'+
                '<div class="sl-tokens">'+tokensHtml+'</div>'+
               '</div>';
    }
    return '<div class="sl-board-outer"><div class="sl-board">'+cells+'</div></div>';
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
      host.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 8 });
      var svgEl = host.querySelector('svg');
      if (svgEl){ svgEl.style.width='160px'; svgEl.style.height='160px'; svgEl.style.borderRadius='8px'; }
    } catch(e){}
  }

  /* ============ VIEWS ============ */
  function viewHome(){
    return '<div class="sl-wrap">' +
      '<h1 class="sl-title">🐍 เกมบันไดงูตอบคำถาม 🪜</h1>' +
      '<p class="sl-sub">โหมด Mass Multiplayer ตอบพร้อมกันทั้งห้อง รองรับผู้เล่น 50+ คน!</p>' +
      '<div class="sl-role-grid">' +
        '<div class="sl-role-card">' +
          '<div class="sl-role-emoji">🖥️</div><h3>สำหรับผู้ดำเนินเกม (Host)</h3>' +
          '<button class="sl-btn sl-btn-gold sl-btn-block" data-act="go-host-setup">สร้างห้องใหม่</button>' +
        '</div>' +
        '<div class="sl-role-card">' +
          '<div class="sl-role-emoji">📱</div><h3>สำหรับผู้เล่น (Player)</h3>' +
          '<button class="sl-btn sl-btn-ghost sl-btn-block" data-act="go-player-join">เข้าร่วมเกม</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function viewHostSetup(){
    var list = S.draftQuestions.map(function(q,i){
      return '<div class="sl-qitem"><b>'+(i+1)+'. '+q.text+'</b> <button class="sl-del" data-act="del-q" data-idx="'+i+'">✕</button></div>';
    }).join('') || '<p class="sl-empty">ยังไม่มีคำถาม (เพิ่มอย่างน้อย 1 ข้อ)</p>';

    return '<div class="sl-wrap">' +
      '<h2>ตั้งค่าชุดคำถามสำหรับเกม</h2>' +
      '<div class="sl-card">' +
        '<input class="sl-input" id="q-text" placeholder="คำถาม">' +
        '<div class="sl-choice-row">' +
          '<div><input type="radio" name="q-c" value="0" checked> <input class="sl-input" id="q-c0" placeholder="ตัวเลือก 1 (ถูก)"></div>' +
          '<div><input type="radio" name="q-c" value="1"> <input class="sl-input" id="q-c1" placeholder="ตัวเลือก 2"></div>' +
          '<div><input type="radio" name="q-c" value="2"> <input class="sl-input" id="q-c2" placeholder="ตัวเลือก 3"></div>' +
          '<div><input type="radio" name="q-c" value="3"> <input class="sl-input" id="q-c3" placeholder="ตัวเลือก 4"></div>' +
        '</div>' +
        '<button class="sl-btn sl-btn-ghost" style="margin-top:10px" data-act="add-q">+ เพิ่มคำถาม</button>' +
      '</div>' +
      '<div style="margin-top:10px">'+list+'</div>' +
      '<div style="margin-top:15px;display:flex;gap:10px">' +
        '<button class="sl-btn sl-btn-gold" data-act="create-room">สร้างห้องเลย →</button>' +
        '<button class="sl-btn sl-btn-ghost" data-act="home">← กลับ</button>' +
      '</div>' +
    '</div>';
  }

  function viewHostLobby(){
    var room = S.room;
    return '<div class="sl-wrap">' +
      '<h2>รอผู้เล่นเข้าห้อง (เข้าร่วมแล้ว: '+room.players.length+' คน)</h2>' +
      '<div class="sl-lobby-grid">' +
        '<div class="sl-card" style="text-align:center">' +
          '<div style="font-size:14px">รหัสเข้าห้อง</div>' +
          '<div class="sl-code">'+room.code+'</div>' +
          '<div id="sl-qrcode" style="display:flex;justify-content:center;margin:10px 0"></div>' +
        '</div>' +
        '<div class="sl-card">' +
          '<h3>ผู้เล่นในห้อง</h3>' +
          '<div class="sl-player-list-scroll">' +
            room.players.map(function(p){ return '<span class="sl-chip">'+p.avatar+' '+p.name+'</span>'; }).join('') +
          '</div>' +
          '<button class="sl-btn sl-btn-gold sl-btn-block" style="margin-top:15px" data-act="start-game">เริ่มเกมตอบคำถาม 🎲</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function viewHostGame(){
    var room = S.room;
    if (room.status === 'finished') return viewWin(true);

    var round = room.round;
    var answeredCount = Object.keys(round.answers || {}).length;

    // Leaderboard Top 5
    var topPlayers = room.players.slice().sort(function(a,b){ return b.pos - a.pos; }).slice(0, 5);

    var roundUI = '';
    if (round.state === 'answering'){
      roundUI = '<div class="sl-card sl-host-qbox">' +
        '<div class="sl-timer-badge">⏱️ เหลือเวลา: '+round.timer+' วินาที</div>' +
        '<h3>❓ คำถาม: '+round.question.text+'</h3>' +
        '<p style="color:#21B6B6;font-size:16px;font-weight:bold">ตอบแล้ว: '+answeredCount+' / '+room.players.length+' คน</p>' +
      '</div>';
    } else {
      roundUI = '<div class="sl-card sl-host-qbox">' +
        '<h3>เฉลย: '+round.question.choices[round.question.correct]+'</h3>' +
        '<button class="sl-btn sl-btn-gold" data-act="next-q">เริ่มข้อถัดไป ➔</button>' +
      '</div>';
    }

    return '<div class="sl-wrap">' +
      roundUI +
      '<div class="sl-game-grid">' +
        '<div>' + renderBoardHTML(room) + '</div>' +
        '<div class="sl-card">' +
          '<h3>🏆 ผู้นำ Top 5</h3>' +
          '<div>' + topPlayers.map(function(p, i){ return '<div class="sl-rank-row"><span>#'+(i+1)+' '+p.avatar+' '+p.name+'</span><b>ช่อง '+p.pos+'</b></div>'; }).join('') + '</div>' +
          '<h4 style="margin-top:15px">📜 บันทึกเกม</h4>' +
          '<div class="sl-log">' + (round.log||[]).map(function(l){ return '<div>'+l+'</div>'; }).join('') + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function viewPlayerJoin(){
    return '<div class="sl-wrap">' +
      '<h2>เข้าร่วมเล่นเกม</h2>' +
      '<div class="sl-card" style="max-width:380px;margin:0 auto">' +
        '<label>รหัสห้อง (4 ตัวอักษร)</label>' +
        '<input class="sl-input mono" id="pj-code" value="' + (S._pendingJoinCode || '') + '" maxlength="4" style="text-transform:uppercase;text-align:center;font-size:24px">' +
        '<label style="margin-top:10px">ชื่อของคุณ</label>' +
        '<input class="sl-input" id="pj-name" placeholder="ชื่อเล่น">' +
        '<label style="margin-top:10px">เลือกตัวละคร</label>' +
        '<div class="sl-avatar-grid">' +
          AVATARS.map(function(a){ return '<button class="sl-av-btn '+(S._pickedAvatar===a?'picked':'')+'" data-act="pick-av" data-av="'+a+'">'+a+'</button>'; }).join('') +
        '</div>' +
        '<button class="sl-btn sl-btn-gold sl-btn-block" style="margin-top:15px" data-act="do-join">เข้าห้องเกม</button>' +
      '</div>' +
    '</div>';
  }

  function viewPlayerGame(){
    var room = S.room;
    if (!room) return '<div>กำลังโหลด...</div>';
    if (room.status === 'finished') return viewWin(false);

    var me = room.players.find(function(x){ return x.id === S.playerId; });
    if (!me) return '<div>ไม่พบข้อมูลผู้เล่น</div>';

    if (room.status === 'lobby'){
      return '<div class="sl-wrap"><div class="sl-card" style="text-align:center;padding:30px">' +
        '<div style="font-size:50px">'+me.avatar+'</div>' +
        '<h2>สวัสดี, '+me.name+'!</h2>' +
        '<p>อยู่ในห้อง <b class="mono">'+room.code+'</b> (ผู้เล่นในห้อง: '+room.players.length+' คน)<br>รอโฮสต์เริ่มเกม...</p>' +
      '</div></div>';
    }

    var round = room.round;
    var myAns = (round.answers || {})[S.playerId];
    var myResult = (round.lastResults || {})[S.playerId];

    var body = '';
    if (round.state === 'answering'){
      body = '<div class="sl-card">' +
        '<div class="sl-timer-badge">⏱️ เวลาตอบ: '+round.timer+' วินาที</div>' +
        '<h3 style="font-size:18px">❓ '+round.question.text+'</h3>' +
        '<div class="sl-choices-grid">' +
          round.question.choices.map(function(c, i){
            var isSelected = (myAns === i);
            return '<button class="sl-choice-btn '+(isSelected?'selected':'')+'" data-act="ans" data-i="'+i+'">'+c+'</button>';
          }).join('') +
        '</div>' +
      '</div>';
    } else {
      body = '<div class="sl-card" style="text-align:center;padding:20px">' +
        '<h3>เฉลย: '+round.question.choices[round.question.correct]+'</h3>' +
        '<div class="sl-my-result '+(myResult && myResult.correct ? 'correct' : 'wrong')+'">' +
          (myResult ? myResult.msg : 'ประมวลผล...') +
        '</div>' +
        '<p style="color:#8a8468;margin-top:10px">รอข้อถัดไปจากโฮสต์...</p>' +
      '</div>';
    }

    return '<div class="sl-wrap">' +
      '<div class="sl-turn-banner">'+me.avatar+' <b>'+me.name+'</b> — อยู่ที่ช่อง <b style="font-size:20px;color:#FFDB6B">'+me.pos+'</b> / 36</div>' +
      body +
    '</div>';
  }

  function viewWin(isHost){
    var room = S.room;
    return '<div class="sl-wrap"><div class="sl-card" style="text-align:center;padding:40px">' +
      '<div style="font-size:60px">🏆</div>' +
      '<h2>จบเกมแล้ว!</h2>' +
      '<h3 style="color:#FFDB6B">ผู้ชนะ: '+room.winner+'</h3>' +
      (isHost ? '<button class="sl-btn sl-btn-gold" style="margin-top:15px" data-act="play-again">เล่นอีกครั้ง</button>' : '<p>รอโฮสต์เริ่มเกมใหม่...</p>') +
      '<div><button class="sl-btn sl-btn-ghost" style="margin-top:10px" data-act="home">กลับหน้าแรก</button></div>' +
    '</div></div>';
  }

  /* ============ MAIN RENDER ============ */
  function render(){
    var app = document.getElementById('sl-app');
    if (!app) return;
    var html = '';
    if (!S.booted){ app.innerHTML = '<div class="sl-wrap">กำลังเชื่อมต่อ...</div>'; return; }

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
  }

  /* ============ EVENTS ============ */
  document.body.addEventListener('click', function(ev){
    var t = ev.target.closest('[data-act]');
    if (!t) return;
    var act = t.getAttribute('data-act');

    if (act==='go-host-setup'){ S.role='host'; S.room=null; render(); }
    else if (act==='go-player-join'){ S.role='player'; render(); }
    else if (act==='home'){ resetToHome(); }
    else if (act==='add-q'){
      var text = document.getElementById('q-text').value.trim();
      var c0 = document.getElementById('q-c0').value.trim();
      var c1 = document.getElementById('q-c1').value.trim();
      var c2 = document.getElementById('q-c2').value.trim();
      var c3 = document.getElementById('q-c3').value.trim();
      var rad = document.querySelector('input[name="q-c"]:checked');
      var correct = rad ? parseInt(rad.value) : 0;
      var choices = [c0,c1,c2,c3].filter(function(x){ return x.length>0; });
      if (!text || choices.length < 2){ toast('กรอกคำถามและตัวเลือกอย่างน้อย 2 ข้อ'); return; }
      S.draftQuestions.push({ id: uid8(), text: text, choices: choices, correct: correct });
      render();
    }
    else if (act==='del-q'){
      S.draftQuestions.splice(parseInt(t.getAttribute('data-idx')), 1);
      render();
    }
    else if (act==='create-room'){ createRoom(); }
    else if (act==='start-game'){ startGame(); }
    else if (act==='next-q'){ nextQuestionRound(); }
    else if (act==='play-again'){ playAgain(); }
    else if (act==='pick-av'){ S._pickedAvatar = t.getAttribute('data-av'); render(); }
    else if (act==='do-join'){
      var code = document.getElementById('pj-code').value;
      var name = document.getElementById('pj-name').value;
      joinRoom(code, name, S._pickedAvatar);
    }
    else if (act==='ans'){
      submitAnswer(parseInt(t.getAttribute('data-i')));
    }
  });

  /* ============ BOOT ============ */
  async function boot(){
    S.booted = true;
    var urlParams = new URLSearchParams(window.location.search);
    var roomFromUrl = (urlParams.get('room') || '').toUpperCase().trim();
    var session = loadSession();

    if (roomFromUrl && session && session.roomCode !== roomFromUrl){ clearSession(); session = null; }

    if (session && session.roomCode){
      var room = await loadRoomOnce(session.roomCode);
      if (room){
        S.role = session.role; S.roomCode = session.roomCode; S.playerId = session.playerId; S.room = room;
        attachRoomListener(session.roomCode);
        render();
        return;
      }
    }

    if (roomFromUrl){ S._pendingJoinCode = roomFromUrl; S.role = 'player'; }
    render();
  }

  function initFirebase(){
    if (!isConfigured()){ render(); return; }
    try {
      firebase.initializeApp(firebaseConfig);
      db = firebase.database();
      auth = firebase.auth();
    } catch(e){ render(); return; }

    auth.onAuthStateChanged(function(user){
      if (user){ S.uid = user.uid; boot(); }
    });
    auth.signInAnonymously();
  }

  render();
  initFirebase();
})();
