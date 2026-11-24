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

// Mirrors the main app's isDayOff(emp, d) (faceclock-firebase.html) — a day is off when an explicit
// shiftOverride says so, else when it's a company holiday, else when it matches the employee's weekly
// daysOff, else (no daysOff configured) when it's a weekend. Needed so reminders don't fire on days the
// employee isn't expected to work at all — date-only math, no local timezone dependency (dateISO is
// already Thai-calendar-aligned via todayISO()).
function weekdayOf(dateISO){
  var p = dateISO.split("-");
  return new Date(Date.UTC(+p[0], +p[1]-1, +p[2])).getUTCDay();
}
function isDayOff(emp, dateISO, overridesByKey, holidaySet){
  var o = overridesByKey[emp.id + "_" + dateISO];
  if(o && o.dayType === "off") return true;
  if(o && o.dayType === "work") return false;
  if(holidaySet[dateISO]) return true;
  if(emp.daysOff && emp.daysOff.length) return emp.daysOff.indexOf(weekdayOf(dateISO)) !== -1;
  var w = weekdayOf(dateISO);
  return w === 0 || w === 6;
}

async function processReminders(empSnap){
  var date = todayISO();
  var nowMin = nowMinutes();

  var results = await Promise.all([
    db.collection("shiftOverrides").where("date", "==", date).get(),
    db.collection("attendance").where("date", "==", date).get(),
    db.collection("telegramReminders").where("date", "==", date).get(),
    db.collection("holidays").get()
  ]);
  var overSnap = results[0], attSnap = results[1], remindedSnap = results[2], holidaySnap = results[3];

  var empById = {};
  empSnap.forEach(function(doc){ empById[doc.id] = Object.assign({ id: doc.id }, doc.data()); });

  var overridesByKey = {};
  overSnap.forEach(function(doc){
    var o = doc.data();
    overridesByKey[o.empId + "_" + o.date] = o;
  });

  var holidaySet = {};
  holidaySnap.forEach(function(doc){ holidaySet[doc.data().date] = true; });

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

  // CC_UIDS (owner + both CEOs, defined below) gets ONE consolidated alert per run listing anyone
  // who's actually missed a scan (the "_after" — deadline-passed — reminders only, not the "_before"
  // heads-up ones, since those aren't a problem yet). Silent when nobody missed anything: replaced
  // a per-employee-per-reminder CC (up to 4 messages × every employee × every day) that was both too
  // noisy to be useful and added to the Firestore read-quota overage.
  var missed = [];
  function remind(emp, type, text){
    if(reminded[emp.id + "_" + type]) return;
    jobs.push(
      tgCall("sendMessage", { chat_id: emp.telegramChatId, text: text }).then(function(){
        return db.collection("telegramReminders").add({ empId: emp.id, date: date, type: type, sentAt: new Date().toISOString() });
      })
    );
    if(type === "in_after") missed.push((emp.nickname || emp.name) + " (ยังไม่สแกนเข้างาน)");
    if(type === "out_after") missed.push((emp.nickname || emp.name) + " (ยังไม่สแกนออกงาน)");
  }

  empSnap.forEach(function(empDoc){
    var emp = empById[empDoc.id];
    if(emp.active === false) return;
    if(!emp.telegramChatId) return;
    if(emp.role === "ceo") return; // CEO is the owner — not expected to clock in/out, so no personal shift reminders
    if(emp.dailyOnly && !overridesByKey[emp.id + "_" + date]) return; // no shift set today, nothing to remind about
    if(isDayOff(emp, date, overridesByKey, holidaySet)) return; // today is this employee's day off, nothing to remind about

    var eff = effectiveShift(emp, overridesByKey, date);
    var rec = attByEmp[emp.id];
    var checkinLimit = emp.shift === "fixed" ? eff.winStart : eff.winEnd;

    // check-in reminders (only while not checked in yet today)
    if((!rec || !rec.checkIn) && checkinLimit != null){
      if(nowMin >= checkinLimit - BEFORE_LEAD_MIN && nowMin < checkinLimit){
        remind(emp, "in_before", "⏰ ใกล้ถึงเวลาเข้างานแล้วนะครับ อย่าลืมสแกนหน้าเข้างาน!");
      }
      if(nowMin > checkinLimit && nowMin <= checkinLimit + AFTER_TAIL_MIN){
        remind(emp, "in_after", "⚠️ เลยเวลาเข้างานแล้วนะครับ ยังไม่เห็นสแกนเข้างานเลย รีบสแกนด้วยนะครับ!");
      }
    }

    // check-out reminders (only for fixed-schedule shifts; flex shifts have no fixed checkout deadline)
    if(emp.shift === "fixed" && rec && rec.checkIn && !rec.checkOut && eff.winEnd != null){
      if(nowMin >= eff.winEnd - BEFORE_LEAD_MIN && nowMin < eff.winEnd){
        remind(emp, "out_before", "⏰ ใกล้ถึงเวลาเลิกงานแล้วนะครับ อย่าลืมสแกนหน้าออกงาน!");
      }
      if(nowMin > eff.winEnd && nowMin <= eff.winEnd + AFTER_TAIL_MIN){
        remind(emp, "out_after", "⚠️ เลยเวลาเลิกงานแล้วนะครับ ยังไม่เห็นสแกนออกงานเลย อย่าลืมสแกนด้วยนะครับ!");
      }
    }
  });

  if(missed.length){
    var missedText = "⚠️ มีพนักงานยังไม่ได้สแกนหน้า:\n- " + missed.join("\n- ");
    // Owner + both CEOs (CC_UIDS) plus every connected HR-role employee — deduped so nobody who's
    // in both lists gets it twice.
    var missedTargets = CC_UIDS.slice();
    empSnap.forEach(function(doc){ if(doc.data().role === "hr") missedTargets.push(doc.id); });
    var sentTo = {};
    missedTargets.forEach(function(uid){
      if(sentTo[uid]) return;
      sentTo[uid] = true;
      var cc = empById[uid];
      if(!cc || !cc.telegramChatId) return;
      jobs.push(tgCall("sendMessage", { chat_id: cc.telegramChatId, text: missedText }));
    });
  }

  await Promise.all(jobs);
}

var HR_ROLES = { hr: 1, admin: 1, ceo: 1 };
// Everyone who gets a CC copy of every approval-chain stage (leave/swap/self-swap), regardless of
// whether they're the direct approver at that stage — the original owner plus both CEO accounts.
var CC_UIDS = ["DRcDoZia2uQmxvYXN5cM61JX5h23", "ExsAKxYnBDbxPnOjIskDCkUmh0x2", "UsPXNk2TjLhD4uWZa5jYGyDJtCm2"];

// Separate from processReminders() above — does not touch or depend on the check-in/out shift reminders at all.
// Notifies whoever is the current required approver (same chain as the app's canApprove()/requiredApproverUidFor()):
// the requester's own supervisor while a leave is at "รออนุมัติ (หัวหน้าทีม)" (or every connected HR/admin/ceo if
// the requester has no supervisor), then every connected HR/admin/ceo once it reaches "รออนุมัติ (HR)".
// Also notifies the REQUESTER once the leave reaches a final result ("อนุมัติแล้ว" or "ไม่อนุมัติ").
// Everyone in CC_UIDS additionally gets a CC copy of every stage so they can follow the whole chain
// without having to be the direct approver at each step — requested after a routing mix-up where they
// only saw the later-stage message and assumed it was the first/only one.
async function processLeaveNotifications(empSnap){
  var results = await Promise.all([
    db.collection("leaves").get(),
    db.collection("telegramLeaveNotified").get()
  ]);
  var leaveSnap = results[0], notifiedSnap = results[1];

  var empById = {};
  var hrTargets = [];
  empSnap.forEach(function(doc){
    var e = Object.assign({ id: doc.id }, doc.data());
    empById[e.id] = e;
    if(HR_ROLES[e.role] && e.telegramChatId) hrTargets.push(e);
  });

  var notified = {};
  notifiedSnap.forEach(function(doc){
    var n = doc.data();
    notified[n.leaveId + "_" + n.status + "_" + n.targetEmpId] = true;
  });

  var jobs = [];

  function sendAndMark(lv, chatId, targetEmpId, text){
    var key = lv.id + "_" + lv.status + "_" + targetEmpId;
    if(notified[key]) return;
    notified[key] = true; // guard against sending twice within the same run
    jobs.push(
      tgCall("sendMessage", { chat_id: chatId, text: text }).then(function(){
        return db.collection("telegramLeaveNotified").add({ leaveId: lv.id, status: lv.status, targetEmpId: targetEmpId, sentAt: new Date().toISOString() });
      })
    );
  }

  // excludeIds lists who NOT to CC — normally just the person(s) who already got the direct message
  // in this same event, never "skip the whole CC list because someone in it happened to be the direct
  // recipient" (that was the bug: when the direct target was itself a CC_UIDS member, e.g. a
  // supervisor who is also a CEO, the old code skipped CC'ing entirely, so the OTHER CC_UIDS members —
  // including the owner, even on their OWN leave request — never heard about it at all).
  function ccOwner(lv, text, excludeIds){
    excludeIds = excludeIds || [];
    CC_UIDS.forEach(function(uid){
      if(excludeIds.indexOf(uid) !== -1) return;
      var cc = empById[uid];
      if(!cc || !cc.telegramChatId) return;
      sendAndMark(lv, cc.telegramChatId, "CC_" + uid, "👁 (สำเนาแจ้งเตือน)\n" + text);
    });
  }

  // stageText is addressed to the actual approver ("รอคุณอนุมัติ..."); ccStageText is the same stage
  // described in neutral/third-person form, since the owner's CC copy isn't necessarily the one who
  // needs to act (e.g. they aren't HR, just watching) — reusing stageText verbatim in the CC would
  // wrongly claim "you, as HR, need to approve this" even when the owner holds a different role.
  // excludeIds defaults to just [target.id]; callers notifying several direct targets at once (e.g.
  // every HR-role employee) pass the full set of those targets' ids so the one shared CC pass doesn't
  // re-notify any of them while still reaching the rest of CC_UIDS.
  function notifyTarget(lv, target, requesterName, stageText, ccStageText, excludeIds){
    var range = lv.start === lv.end ? lv.start : (lv.start + " – " + lv.end);
    var text = "📋 " + requesterName + " ยื่น" + lv.type + " (" + range + ")\nเหตุผล: " + (lv.reason || "-") + "\n" + stageText + " — เข้าแอป FaceClock HR เพื่ออนุมัติครับ";
    sendAndMark(lv, target.telegramChatId, target.id, text);
    var ccText = "📋 " + requesterName + " ยื่น" + lv.type + " (" + range + ")\nเหตุผล: " + (lv.reason || "-") + "\nสถานะ: " + ccStageText;
    ccOwner(lv, ccText, excludeIds || [target.id]);
  }

  // Notifies the REQUESTER once their leave reaches a final result (approved or rejected) — separate
  // from notifyTarget() above, which notifies the approver while a leave is still pending.
  function notifyRequesterResult(lv, requester){
    var range = lv.start === lv.end ? lv.start : (lv.start + " – " + lv.end);
    var text = lv.status === "อนุมัติแล้ว"
      ? ("✅ ใบลา" + lv.type + " (" + range + ") ของคุณได้รับการอนุมัติแล้วครับ")
      : ("❌ ใบลา" + lv.type + " (" + range + ") ของคุณไม่ได้รับการอนุมัติครับ");
    if(requester.telegramChatId) sendAndMark(lv, requester.telegramChatId, requester.id, text);
    var requesterName = requester.nickname || requester.name;
    ccOwner(lv, (lv.status === "อนุมัติแล้ว" ? "✅ " : "❌ ") + requesterName + " — ใบลา" + lv.type + " (" + range + ") " + (lv.status === "อนุมัติแล้ว" ? "ได้รับการอนุมัติแล้ว" : "ไม่ได้รับการอนุมัติ"), [requester.id]);
  }

  leaveSnap.forEach(function(doc){
    var lv = Object.assign({ id: doc.id }, doc.data());
    var requester = empById[lv.empId];
    if(!requester) return;

    if(lv.status === "อนุมัติแล้ว" || lv.status === "ไม่อนุมัติ"){
      notifyRequesterResult(lv, requester);
      return;
    }
    if(lv.status !== "รออนุมัติ (หัวหน้าทีม)" && lv.status !== "รออนุมัติ (HR)") return;
    var requesterName = requester.nickname || requester.name;

    if(lv.status === "รออนุมัติ (HR)"){
      var hrIds = hrTargets.map(function(t){ return t.id; });
      hrTargets.forEach(function(t){ notifyTarget(lv, t, requesterName, "รอ HR อนุมัติ", "รอ HR อนุมัติ", hrIds); });
      return;
    }
    // รออนุมัติ (หัวหน้าทีม)
    if(requester.supervisorId){
      var supervisor = empById[requester.supervisorId];
      if(supervisor && supervisor.telegramChatId) notifyTarget(lv, supervisor, requesterName, "รอคุณอนุมัติในฐานะหัวหน้าทีม", "รอหัวหน้าทีมอนุมัติ");
    } else {
      // no supervisor assigned — this employee reports straight to HR, so the recipient here is acting as HR, not as "their supervisor"
      var hrIds2 = hrTargets.map(function(t){ return t.id; });
      hrTargets.forEach(function(t){ notifyTarget(lv, t, requesterName, "ไม่มีหัวหน้าทีม รอคุณอนุมัติในฐานะ HR", "ไม่มีหัวหน้าทีม รอ HR อนุมัติ", hrIds2); });
    }
  });

  await Promise.all(jobs);
}

// Notifies the coworker-swap chain (same stages as the app's canApproveSwap()):
// the target coworker while "รอเพื่อนยืนยัน", then whoever approves (the requester's+target's shared
// supervisor if both report to the same one, else every connected HR/admin/ceo) while "รออนุมัติ",
// then the requester (and, once actually approved, the target too — their shift changes as well)
// once the request reaches a final result. Owner gets a CC of every stage, same as leave notifications.
async function processSwapNotifications(empSnap){
  var results = await Promise.all([
    db.collection("swapRequests").get(),
    db.collection("telegramSwapNotified").get()
  ]);
  var swapSnap = results[0], notifiedSnap = results[1];

  var empById = {};
  var hrTargets = [];
  empSnap.forEach(function(doc){
    var e = Object.assign({ id: doc.id }, doc.data());
    empById[e.id] = e;
    if(HR_ROLES[e.role] && e.telegramChatId) hrTargets.push(e);
  });

  var notified = {};
  notifiedSnap.forEach(function(doc){
    var n = doc.data();
    notified[n.swapId + "_" + n.status + "_" + n.targetEmpId] = true;
  });

  var jobs = [];

  function sendAndMark(s, chatId, targetEmpId, text){
    var key = s.id + "_" + s.status + "_" + targetEmpId;
    if(notified[key]) return;
    notified[key] = true;
    jobs.push(
      tgCall("sendMessage", { chat_id: chatId, text: text }).then(function(){
        return db.collection("telegramSwapNotified").add({ swapId: s.id, status: s.status, targetEmpId: targetEmpId, sentAt: new Date().toISOString() });
      })
    );
  }

  // excludeIds: who NOT to CC — see the equivalent comment on ccOwner() in processLeaveNotifications()
  // for why this can never be "skip the whole CC pass because the direct target is a CC_UIDS member".
  function ccOwner(s, text, excludeIds){
    excludeIds = excludeIds || [];
    CC_UIDS.forEach(function(uid){
      if(excludeIds.indexOf(uid) !== -1) return;
      var cc = empById[uid];
      if(!cc || !cc.telegramChatId) return;
      sendAndMark(s, cc.telegramChatId, "CC_" + uid, "👁 (สำเนาแจ้งเตือน)\n" + text);
    });
  }

  // ccText defaults to text, but any message addressed to the target as "คุณ" ("กับคุณ", "ของคุณ")
  // needs a neutral third-person version instead, since the owner's CC copy may not be that target —
  // see the equivalent comment in processLeaveNotifications() for why.
  function notifyOne(s, target, text, ccText, excludeIds){
    if(target.telegramChatId) sendAndMark(s, target.telegramChatId, target.id, text);
    ccOwner(s, ccText || text, excludeIds || [target.id]);
  }

  swapSnap.forEach(function(doc){
    var s = Object.assign({ id: doc.id }, doc.data());
    var req = empById[s.requesterId], tgt = empById[s.targetId];
    if(!req || !tgt) return;
    var reqName = req.nickname || req.name, tgtName = tgt.nickname || tgt.name;
    var range = "หยุด " + s.myDate + " / ทำงานแทน " + s.theirDate;

    if(s.status === "อนุมัติแล้ว" || s.status === "ไม่อนุมัติ"){
      var resultText = s.status === "อนุมัติแล้ว"
        ? ("✅ คำขอสลับวันหยุดระหว่าง " + reqName + " กับ " + tgtName + " (" + range + ") ได้รับการอนุมัติแล้วครับ")
        : ("❌ คำขอสลับวันหยุดระหว่าง " + reqName + " กับ " + tgtName + " (" + range + ") ไม่ได้รับการอนุมัติครับ");
      if(req.telegramChatId) sendAndMark(s, req.telegramChatId, req.id, resultText);
      if(tgt.telegramChatId) sendAndMark(s, tgt.telegramChatId, tgt.id, resultText);
      ccOwner(s, resultText, [req.id, tgt.id]);
      return;
    }
    if(s.status === "ปฏิเสธโดยเพื่อนร่วมงาน"){
      notifyOne(s, req, "❌ " + tgtName + " ปฏิเสธคำขอสลับวันหยุดของคุณ (" + range + ") ครับ",
        "❌ " + tgtName + " ปฏิเสธคำขอสลับวันหยุดของ " + reqName + " (" + range + ") ครับ");
      return;
    }
    if(s.status === "รอเพื่อนยืนยัน"){
      notifyOne(s, tgt, "🔁 " + reqName + " ขอสลับวันหยุดกับคุณ (" + range + ") — เข้าแอป FaceClock HR เพื่อยืนยันครับ",
        "🔁 " + reqName + " ขอสลับวันหยุดกับ " + tgtName + " (" + range + ") — รอ " + tgtName + " ยืนยัน");
      return;
    }
    if(s.status === "รออนุมัติ"){
      var text = "🔁 " + reqName + " ↔ " + tgtName + " ขอสลับวันหยุด (" + range + ") เพื่อนยืนยันแล้ว รออนุมัติ — เข้าแอป FaceClock HR เพื่ออนุมัติครับ";
      var sharedSupervisor = req.supervisorId && tgt.supervisorId && req.supervisorId === tgt.supervisorId ? empById[req.supervisorId] : null;
      if(sharedSupervisor){
        notifyOne(s, sharedSupervisor, text);
      } else {
        var hrIds = hrTargets.map(function(t){ return t.id; });
        hrTargets.forEach(function(t){ notifyOne(s, t, text, null, hrIds); });
      }
    }
  });

  await Promise.all(jobs);
}

// Notifies the self-swap chain — identical two-stage approval chain to leaves (requester's supervisor,
// then HR, once the request reaches a final result the requester is notified). Owner gets a CC of
// every stage, same as leave notifications.
async function processSelfSwapNotifications(empSnap){
  var results = await Promise.all([
    db.collection("selfSwapRequests").get(),
    db.collection("telegramSelfSwapNotified").get()
  ]);
  var reqSnap = results[0], notifiedSnap = results[1];

  var empById = {};
  var hrTargets = [];
  empSnap.forEach(function(doc){
    var e = Object.assign({ id: doc.id }, doc.data());
    empById[e.id] = e;
    if(HR_ROLES[e.role] && e.telegramChatId) hrTargets.push(e);
  });

  var notified = {};
  notifiedSnap.forEach(function(doc){
    var n = doc.data();
    notified[n.reqId + "_" + n.status + "_" + n.targetEmpId] = true;
  });

  var jobs = [];

  function sendAndMark(r, chatId, targetEmpId, text){
    var key = r.id + "_" + r.status + "_" + targetEmpId;
    if(notified[key]) return;
    notified[key] = true;
    jobs.push(
      tgCall("sendMessage", { chat_id: chatId, text: text }).then(function(){
        return db.collection("telegramSelfSwapNotified").add({ reqId: r.id, status: r.status, targetEmpId: targetEmpId, sentAt: new Date().toISOString() });
      })
    );
  }

  // excludeIds: who NOT to CC — see the equivalent comment on ccOwner() in processLeaveNotifications()
  // for why this can never be "skip the whole CC pass because the direct target is a CC_UIDS member".
  function ccOwner(r, text, excludeIds){
    excludeIds = excludeIds || [];
    CC_UIDS.forEach(function(uid){
      if(excludeIds.indexOf(uid) !== -1) return;
      var cc = empById[uid];
      if(!cc || !cc.telegramChatId) return;
      sendAndMark(r, cc.telegramChatId, "CC_" + uid, "👁 (สำเนาแจ้งเตือน)\n" + text);
    });
  }

  // ccStageText is the neutral/third-person version of stageText — see the comment on the equivalent
  // function in processLeaveNotifications() for why the CC copy can't just reuse the "รอคุณอนุมัติ..." text.
  function notifyTarget(r, target, requesterName, stageText, ccStageText, excludeIds){
    var range = "หยุด " + r.myDate + " / ทำงานแทน " + r.theirDate;
    var text = "🔁 " + requesterName + " ขอเปลี่ยนวันหยุดของตัวเอง (" + range + ")\nเหตุผล: " + (r.reason || "-") + "\n" + stageText + " — เข้าแอป FaceClock HR เพื่ออนุมัติครับ";
    if(target.telegramChatId) sendAndMark(r, target.telegramChatId, target.id, text);
    var ccText = "🔁 " + requesterName + " ขอเปลี่ยนวันหยุดของตัวเอง (" + range + ")\nเหตุผล: " + (r.reason || "-") + "\nสถานะ: " + ccStageText;
    ccOwner(r, ccText, excludeIds || [target.id]);
  }

  function notifyRequesterResult(r, requester){
    var range = "หยุด " + r.myDate + " / ทำงานแทน " + r.theirDate;
    var text = r.status === "อนุมัติแล้ว"
      ? ("✅ คำขอเปลี่ยนวันหยุดของคุณ (" + range + ") ได้รับการอนุมัติแล้วครับ")
      : ("❌ คำขอเปลี่ยนวันหยุดของคุณ (" + range + ") ไม่ได้รับการอนุมัติครับ");
    if(requester.telegramChatId) sendAndMark(r, requester.telegramChatId, requester.id, text);
    var requesterName = requester.nickname || requester.name;
    ccOwner(r, (r.status === "อนุมัติแล้ว" ? "✅ " : "❌ ") + requesterName + " — คำขอเปลี่ยนวันหยุด (" + range + ") " + (r.status === "อนุมัติแล้ว" ? "ได้รับการอนุมัติแล้ว" : "ไม่ได้รับการอนุมัติ"), [requester.id]);
  }

  reqSnap.forEach(function(doc){
    var r = Object.assign({ id: doc.id }, doc.data());
    var requester = empById[r.empId];
    if(!requester) return;

    if(r.status === "อนุมัติแล้ว" || r.status === "ไม่อนุมัติ"){
      notifyRequesterResult(r, requester);
      return;
    }
    if(r.status !== "รออนุมัติ (หัวหน้าทีม)" && r.status !== "รออนุมัติ (HR)") return;
    var requesterName = requester.nickname || requester.name;

    if(r.status === "รออนุมัติ (HR)"){
      var hrIds = hrTargets.map(function(t){ return t.id; });
      hrTargets.forEach(function(t){ notifyTarget(r, t, requesterName, "รอ HR อนุมัติ", "รอ HR อนุมัติ", hrIds); });
      return;
    }
    if(requester.supervisorId){
      var supervisor = empById[requester.supervisorId];
      if(supervisor && supervisor.telegramChatId) notifyTarget(r, supervisor, requesterName, "รอคุณอนุมัติในฐานะหัวหน้าทีม", "รอหัวหน้าทีมอนุมัติ");
    } else {
      var hrIds2 = hrTargets.map(function(t){ return t.id; });
      hrTargets.forEach(function(t){ notifyTarget(r, t, requesterName, "ไม่มีหัวหน้าทีม รอคุณอนุมัติในฐานะ HR", "ไม่มีหัวหน้าทีม รอ HR อนุมัติ", hrIds2); });
    }
  });

  await Promise.all(jobs);
}

// Separate from the functions above — notifies every connected, active employee once per new
// company announcement (dedup via telegramAnnouncementNotified, keyed by announcement+employee).
async function processAnnouncementNotifications(empSnap){
  var results = await Promise.all([
    db.collection("announcements").get(),
    db.collection("telegramAnnouncementNotified").get()
  ]);
  var annSnap = results[0], notifiedSnap = results[1];

  var targets = [];
  empSnap.forEach(function(doc){
    var e = Object.assign({ id: doc.id }, doc.data());
    if(e.active !== false && e.telegramChatId) targets.push(e);
  });

  var notified = {};
  notifiedSnap.forEach(function(doc){
    var n = doc.data();
    notified[n.annId + "_" + n.targetEmpId] = true;
  });

  var jobs = [];
  annSnap.forEach(function(doc){
    var ann = Object.assign({ id: doc.id }, doc.data());
    targets.forEach(function(t){
      var key = ann.id + "_" + t.id;
      if(notified[key]) return;
      notified[key] = true;
      var text = "📢 ประกาศใหม่: " + ann.title + "\n" + ann.body + "\n— " + ann.author;
      jobs.push(
        tgCall("sendMessage", { chat_id: t.telegramChatId, text: text }).then(function(){
          return db.collection("telegramAnnouncementNotified").add({ annId: ann.id, targetEmpId: t.id, sentAt: new Date().toISOString() });
        })
      );
    });
  });

  await Promise.all(jobs);
}

// Dedup collections (telegramXNotified, telegramReminders) are never written to more than once per
// key, but nothing ever deleted them — after weeks of running every ~1-2 minutes, they grew into the
// biggest share of this project's daily Firestore read quota, since every run used to .get() each one
// in full just to build an in-memory "already sent" lookup. Deleting entries older than STALE_DAYS
// keeps each one bounded to roughly a month of history, so the full-collection reads below stay cheap
// indefinitely instead of growing with the account's entire lifetime.
var STALE_DAYS = 30;
async function pruneStale(collectionName, dateField){
  var cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  var snap = await db.collection(collectionName).where(dateField, "<", cutoff).get();
  if(snap.empty) return;
  var batch = db.batch();
  snap.forEach(function(doc){ batch.delete(doc.ref); });
  await batch.commit();
}

(async function main(){
  try{
    await processRegistrations();
  }catch(e){ console.error("registration error", e); }

  try{
    await Promise.all([
      pruneStale("telegramLeaveNotified", "sentAt"),
      pruneStale("telegramSwapNotified", "sentAt"),
      pruneStale("telegramSelfSwapNotified", "sentAt"),
      pruneStale("telegramAnnouncementNotified", "sentAt"),
      pruneStale("telegramReminders", "sentAt")
    ]);
  }catch(e){ console.error("prune error", e); }

  // employees is read by every function below — fetched once here and passed in, instead of each
  // function re-reading the whole collection independently (was 5x the necessary reads every run).
  var empSnap;
  try{
    empSnap = await db.collection("employees").get();
  }catch(e){ console.error("employees fetch error", e); return; }

  try{
    await processReminders(empSnap);
  }catch(e){ console.error("reminder error", e); }
  try{
    await processLeaveNotifications(empSnap);
  }catch(e){ console.error("leave notification error", e); }
  try{
    await processSwapNotifications(empSnap);
  }catch(e){ console.error("swap notification error", e); }
  try{
    await processSelfSwapNotifications(empSnap);
  }catch(e){ console.error("self-swap notification error", e); }
  try{
    await processAnnouncementNotifications(empSnap);
  }catch(e){ console.error("announcement notification error", e); }
})();
