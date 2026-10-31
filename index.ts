import { Plugin } from "@opencode/plugin"
import { setup } from "./runtime.mjs"
import { registerSessionMcp } from "./mcp-rpc"

export default Plugin.define({
  id: "local-session-mcp",
  setup: async (ctx) => {
    const runtime = await setup(ctx)
    const rpc = await registerSessionMcp(ctx, runtime.api, runtime.log)
    return async () => {
      await rpc.dispose()
      await runtime.cleanup()
    }
  },
})
