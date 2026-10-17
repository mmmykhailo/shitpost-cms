// Frozen incident reproductions for 2026-10-17, asserting the observed defects.
// These are investigation probes, not expectations for corrected product behavior.
// No network access: all Telegram responses are injected.
import assert from "node:assert/strict";
const test = async (name: string, run: () => Promise<void>) => { await run(); console.log(`CONFIRMED: ${name}`); };
import { Api } from "grammy";
import { createTestDatabase, markQueueItemPrepared } from "../../test/support";
import { createAlertRepository } from "../../src/db/alert-repository";
import { createAlertService } from "../../src/services/alerts";
import { createFakeClock } from "../../src/clock";
import { createTelegramCooldownRepository } from "../../src/db/telegram-cooldown-repository";
import { createTelegramCooldown, installTelegramCooldownTransformer } from "../../src/telegram-cooldown";
import { createTelegramGateway } from "../../src/telegram";
import { createQueueRepository, createScheduleRepository } from "../../src/db/repositories";
import { createPublicationService } from "../../src/services/publisher";
import { createSchedulerService } from "../../src/services/scheduler";
import { snapshotFixture } from "../../test/fixtures";
import { asChatId, asMessageId } from "../../src/types";
const logger = {debug(){},info(){},warn(){},error(){}};
function harness() {
 const resource = createTestDatabase("incident-repro");
 const clock = createFakeClock(Date.parse("2026-10-17T07:00:00Z"));
 const cooldown = createTelegramCooldown({repository:createTelegramCooldownRepository(resource.database), clock});
 const calls: string[] = []; const delivered: string[]=[]; let flood = true;
 const api = new Api("123456:fake-diagnostic-token", {fetch: async (url:any, init:any) => {
  const method = String(url).split("/").at(-1)!; calls.push(method);
  const payload = JSON.parse(init.body);
  let reply:any;
  if(method === "copyMessage" && flood) {flood=false; reply={ok:false,error_code:429,description:"Too Many Requests",parameters:{retry_after:30}};}
  else {if(method === "sendMessage") delivered.push(payload.text); reply={ok:true,result: method === "copyMessage" ? {message_id:800} : method === "sendMessage" ? {message_id:900,chat:{id:42,type:"private"},date:1,text:payload.text} : true};}
  return new Response(JSON.stringify(reply), {headers:{"content-type":"application/json"}});
 }});
 installTelegramCooldownTransformer(api,cooldown,clock);
 const gateway = createTelegramGateway(api,asChatId(42));
 return {...resource,clock,cooldown,api,gateway,calls,delivered};
}
await test("unseen warning produces an orphan recovery message",async()=>{
 const h=harness();try{
  try{await h.api.copyMessage(-200,-100,1);}catch{}
  const alerts=createAlertService({alert:createAlertRepository(h.database),gateway:h.gateway,adminChatId:asChatId(42),logger});
  await alerts.raiseOnChange("shared_issue:flood_wait","immediate","wait",{text:"Telegram mutations are paused"},h.clock.now());
  assert.deepEqual(h.delivered, []);
  h.clock.advance(30_000);
  await alerts.resolve("shared_issue:flood_wait","The shared Telegram flood wait ended.",h.clock.now());
  console.log("Delivered after unseen warning:",JSON.stringify(h.delivered));
  assert.deepEqual(h.delivered, ["Resolved: The shared Telegram flood wait ended."]);
 }finally{h.close();}
});
await test("shared cooldown rejects admin replies before any network request",async()=>{
 const h=harness();try{
  try{await h.api.copyMessage(-200,-100,1);}catch{}
  let result="delivered";
  try{await h.gateway.sendAdminMessage({chatId:asChatId(42),text:"Health response"});}catch{result="rejected locally";}
  console.log("Admin reply:",result,"Actual Telegram requests:",JSON.stringify(h.calls));
  assert.equal(result, "rejected locally");
  assert.deepEqual(h.calls, ["copyMessage"]);
  h.clock.advance(30_000);
  await h.gateway.sendAdminMessage({chatId:asChatId(42),text:"Health response"});
  assert.deepEqual(h.delivered, ["Health response"]);
 }finally{h.close();}
});
await test("definite 429 consumes the scheduled occurrence without retrying",async()=>{
 const h=harness();try{
  const queue=createQueueRepository(h.database);const schedule=createScheduleRepository(h.database);
  queue.observeQueueSnapshot(snapshotFixture({messageId:asMessageId(1),telegramDate:h.clock.now()}),h.clock.now()-1000);
  markQueueItemPrepared(h.database,1,"copy",h.clock.now());
  const publisher=createPublicationService({queue,gateway:h.gateway,queueChannelId:asChatId(-100),targetChannelId:asChatId(-200),clock:h.clock,logger,cooldown:h.cooldown});
  const scheduler=createSchedulerService({schedule,publisher,clock:h.clock,logger});
  schedule.addSlot(7*60,1,h.clock.now()-2000);schedule.setEnabled(true,1,h.clock.now()-2000);schedule.setLastScan(h.clock.now()-1000);
  const first=await scheduler.scanOnce();assert.equal(first.outcome?.kind, "retry_scheduled");
  h.clock.advance(30_000);const second=await scheduler.scanOnce();
  console.log("Scheduled first outcome:",first.outcome?.kind,"after wait:",JSON.stringify(second),"run:",schedule.run(h.clock.now()-30_000)?.status,"item:",queue.findItemById(1)?.status);
  assert.equal(second.ran, false);
  assert.equal(queue.findItemById(1)?.status, "queued");
  // Control: the source is usable after the wait; the scheduler did not retry it.
  await scheduler.manualPublish();
  assert.equal(queue.findItemById(1)?.status, "done");
 }finally{h.close();}
});
