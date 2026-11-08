# MTProxy research backlog

Status on 2026-11-08. Tested proxy configurations and packet-capture evidence are
in `MTProxy-VERIFICATION.md`. This file records what is **not** yet tested and
which experiments are most likely to change the conclusion.

## Known conclusion

The current client network loses the server-to-client TCP path byte stream.
Server-side capture showed 48,218 bytes sent to the client versus 8,671 bytes
received from the client, with 40 extra retransmitted segments. Client ACKs
lagged server sequence ends (for example 771 vs 3207 and 4451 vs 5816), and the
client logged repeated 5-second ping timeouts. This is a path problem, not an
MTProxy process or configuration problem.

## Tested but not in the main matrix

- `--relax-ping` raised teleproto disconnect timers to 60 seconds; media still
  stalled.
- Bot API from the client network: `api.telegram.org` timed out.
- Bot API from the server: token returned `404 Not Found`.
- Receive-only `getMessages`: `me` with limits 1, 2, and 5 worked but found no
  photo; `me` with limit 3 hung; `@telegram` with limit 1 hung.
- `--roundtrip-photo` local PNG encode/decode tests pass; live upload timed out.
- Direct server HTTP on 8000 and host HTTP on 8001 stalled after 9-11 KB.
- gost v2 TLS on 8443/80, gost SOCKS5 on 1080, and a cloudflared quick tunnel
  all stalled on bulk data.

## Untried experiments, in priority order

1. **Synchronized client and server packet capture.** Run `sudo tcpdump -i en0
-w client.pcap 'tcp port 443'` and the server capture at the same time.
   Compare payload bytes, ACKs, retransmits, and RSTs. This separates upload
   payload loss from lost server responses.
2. **Real Telegram client, not teleproto.** Test the macOS app and Telegram
   Desktop through classic, FakeTLS, and a TLS tunnel. The app may use more
   parallel CDN connections than the API client.
3. **Alternative relay paths on the same Wi-Fi.** Test Cloudflare WARP,
   Tailscale DERP, WireGuard, SSH dynamic SOCKS on a reachable port, and a
   second VPS in another region. Keep the client network unchanged.
4. **Loss-resilient transports.** Test a QUIC-based TCP tunnel, hysteria2, or a
   WebSocket/HTTP2 tunnel. TCP MTProxy cannot repair loss; an overlay can
   reorder/retransmit or use a different congestion path.
5. **Server TCP tuning.** Test workers 2, 3, 5, and 6; MSS 1024/1100/1300 (1360 is already known to be too high on this path);
   `tcp_notsent_lowat`, send/receive buffers, ECN, keepalive, and `ss -ti`
   retransmit counters. Do not exceed 6 workers at `nofile=524288`.
6. **Proxy engine variants.** Build the latest official MTProxy source; test
   mtg versions after 2.3.0; test a real client with FakeTLS. The current
   evidence does not justify another engine until the path is fixed.
7. **Client-side media tuning.** Test smaller chunk sizes, parallel file
   requests, forced non-CDN downloads, thumbnail-only previews, and longer
   request timeouts. These can prove the protocol path but will not fix the
   app's default behavior.
8. **Port and address variants.** Test MTProxy on 80/8443/8080, IPv6 if the
   server gets a routed prefix, and alternate server IPs. Port 443 already
   connects, so this is lower priority than relay/path tests.

## Quality improvements

- Add a real-client smoke test in front of the API test, with text, incoming
  photo, outgoing photo, and profile-photo checks.
- Emit machine-readable `API_TEST_*` JSON and a pass/fail matrix that CI can
  consume without Telegram secrets.
- Keep a watchdog for file descriptors, worker count, container restarts, and
  established sockets; alert before the 65552-per-worker limit is hit.
- Add a fallback proxy endpoint or relay and switch only when packet loss or
  ping timeouts cross a threshold.
- Keep packet captures, client IPs, `.lenv`, sessions, and secrets out of git;
  store only redacted summaries and commands.
- Rotate the proxy secret and test the `tg://` link after any transport change.
