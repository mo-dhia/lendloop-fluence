import { httpRouter } from "convex/server";
import { integration } from "./lendloop";
const http = httpRouter();
http.route({
  path: "/lendloop/automation/overdue",
  method: "POST",
  handler: integration,
});
http.route({
  path: "/lendloop/automation/event",
  method: "POST",
  handler: integration,
});
http.route({
  path: "/lendloop/automation/reminder",
  method: "POST",
  handler: integration,
});
export default http;
