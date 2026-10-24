import { make } from "../../../node_modules/.bun/find-my-way-ts@0.1.6/node_modules/find-my-way-ts/dist/esm/index.js"

const router = make()
router.on("PATCH", "/session/:sessionID", () => "ok")
router.on("GET", "/session/:sessionID", () => "get")

const urls = [
  "/session/ses_123?directory=D%3A%5Copencode",
  "/session/ses_123?directory=D:%5Copencode",
  "/session/ses_123?directory=D:\\opencode",
  "http://127.0.0.1:4096/session/ses_123?directory=D%3A%5Copencode",
  "/session/ses_123/?directory=D%3A%5Copencode",
  "/session/ses_123?directory=D%3A%5C%5Copencode",
]

for (const url of urls) {
  const match = router.find("PATCH", url)
  console.log(JSON.stringify(url), match ? JSON.stringify({ params: match.params, search: match.searchParams }) : null)
}
