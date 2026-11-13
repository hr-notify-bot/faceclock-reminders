var admin = require("firebase-admin");

var TOKEN = process.env.TELEGRAM_BOT_TOKEN;
var serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
var db = admin.firestore();

var THAI_OFFSET_MS = 7 * 60 * 60 * 1000;
// Two separate reminders per event: one before the deadline, one after (if still not done).
// Each window is wide so a delayed/jittery GitHub Actions run still catches it
// (dedup via the telegramReminders collection means each type only ever sends once per event per day).
var BEFORE_LEAD_MIN = 10; // "before" window starts this many minutes before the deadline, ends at the deadline
var AFTER_TAIL_MIN = 5;   // "after" window starts at the deadline, ends this many minutes after it

function pad2(n){ return (n < 10 ? "0" : "") + n; }

function nowThai(){
  return new Date(Date.now() + THAI_OFFSET_MS);
}

function todayISO(){
  var d = nowThai();
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
}

function nowMinutes(){
  var d = nowThai();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

async function tgCall(method, params){
  var res = await fetch("https://api.telegram.org/bot" + TOKEN + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params || {})
  });
  var json = await res.json();
  if(!json.ok) console.error(method, "failed:", JSON.stringify(json));
  return json;
}

async function processRegistrations(){
  var stateRef = db.collection("system").doc("telegramState");
  var stateDoc = await stateRef.get();
  var lastUpdateId = stateDoc.exists ? (stateDoc.data().lastUpdateId || 0) : 0;

  var result = await tgCall("getUpdates", { offset: lastUpdateId + 1, timeout: 0 });
  if(!result.ok) return;
  var updates = result.result || [];
  var maxId = lastUpdateId;

  for(var i = 0; i < updates.length; i++){
    var upd = updates[i];
    maxId = Math.max(maxId, upd.update_id);
    var msg = upd.message;
    if(!msg || !msg.text) continue;
    var m = msg.text.trim().match(/^\/start(?:@\S+)?\s+(\S+)/);
    if(!m) continue;
    var empId = m[1];
    var chatId = msg.chat.id;
    var empRef = db.collection("employees").doc(empId);
    var empDoc = await empRef.get();
    if(empDoc.exists){
      await empRef.update({ telegramChatId: chatId });
      var emp = empDoc.data();
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "เชื่อมต่อสำเร็จ! ✅\nคุณ (" + (emp.nickname || emp.name) + ") จะได้รับแจ้งเตือนก่อนเข้า-ออกงาน 5 นาทีจากบอทนี้ครับ"
      });
    } else {
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: "ไม่พบรหัสพนักงานนี้ในระบบ กรุณากดลิงก์เชื่อมต่อจากในแอป FaceClock HR อีกครั้งครับ"
      });
    }
  }

  if(maxId !== lastUpdateId){
    await stateRef.set({ lastUpdateId: maxId }, { merge: true });
  }
}

function effectiveShift(emp, overridesByKey, dateISO){
  var o = overridesByKey[emp.id + "_" + dateISO];
  return {
    winStart: (o && o.winStart != null) ? o.winStart : emp.winStart,
    winEnd: (o && o.winEnd != null) ? o.winEnd : emp.winEnd,
    overridden: !!o
  };
}

async function processReminders(){
  var date = todayISO();
  var nowMin = nowMinutes();

  var results = await Promise.all([
    db.collection("employees").get(),
    db.collection("shiftOverrides").where("date", "==", date).get(),
    db.collection("attendance").where("date", "==", date).get(),
    db.collection("telegramReminders").where("date", "==", date).get()
  ]);
  var empSnap = results[0], overSnap = results[1], attSnap = results[2], remindedSnap = results[3];

  var overridesByKey = {};
  overSnap.forEach(function(doc){
    var o = doc.data();
    overridesByKey[o.empId + "_" + o.date] = o;
  });

  var attByEmp = {};
  attSnap.forEach(function(doc){
    var a = doc.data();
    attByEmp[a.empId] = a;
  });

  var reminded = {};
  remindedSnap.forEach(function(doc){
    var r = doc.data();
    reminded[r.empId + "_" + r.type] = true;
  });

  var jobs = [];

  function remind(emp, type, text){
    if(reminded[emp.id + "_" + type]) return;
    jobs.push(
      tgCall("sendMessage", { chat_id: emp.telegramChatId, text: text }).then(function(){
        return db.collection("telegramReminders").add({ empId: emp.id, date: date, type: type, sentAt: new Date().toISOString() });
      })
    );
  }

  empSnap.forEach(function(empDoc){
    var emp = Object.assign({ id: empDoc.id }, empDoc.data());
    if(emp.active === false) return;
    if(!emp.telegramChatId) return;
    if(emp.dailyOnly && !overridesByKey[emp.id + "_" + date]) return; // no shift set today, nothing to remind about

    var eff = effectiveShift(emp, overridesByKey, date);
    var rec = attByEmp[emp.id];
    var checkinLimit = emp.shift === "fixed" ? eff.winStart : eff.winEnd;

    // check-in reminders (only while not checked in yet today)
    if((!rec || !rec.checkIn) && checkinLimit != null){
      if(nowMin >= checkinLimit - BEFORE_LEAD_MIN && nowMin < checkinLimit){
        remind(emp, "in_before", "⏰ ใกล้ถึงเวลาเข้างานแล้วนะครับ อย่าลืมสแกนหน้าเข้างาน!");
      }
      if(nowMin >= checkinLimit && nowMin <= checkinLimit + AFTER_TAIL_MIN){
        remind(emp, "in_after", "⚠️ เลยเวลาเข้างานแล้วนะครับ ยังไม่เห็นสแกนเข้างานเลย รีบสแกนด้วยนะครับ!");
      }
    }

    // check-out reminders (only for fixed-schedule shifts; flex shifts have no fixed checkout deadline)
    if(emp.shift === "fixed" && rec && rec.checkIn && !rec.checkOut && eff.winEnd != null){
      if(nowMin >= eff.winEnd - BEFORE_LEAD_MIN && nowMin < eff.winEnd){
        remind(emp, "out_before", "⏰ ใกล้ถึงเวลาเลิกงานแล้วนะครับ อย่าลืมสแกนหน้าออกงาน!");
      }
      if(nowMin >= eff.winEnd && nowMin <= eff.winEnd + AFTER_TAIL_MIN){
        remind(emp, "out_after", "⚠️ เลยเวลาเลิกงานแล้วนะครับ ยังไม่เห็นสแกนออกงานเลย อย่าลืมสแกนด้วยนะครับ!");
      }
    }
  });

  await Promise.all(jobs);
}

(async function main(){
  try{
    await processRegistrations();
  }catch(e){ console.error("registration error", e); }
  try{
    await processReminders();
  }catch(e){ console.error("reminder error", e); }
})();
