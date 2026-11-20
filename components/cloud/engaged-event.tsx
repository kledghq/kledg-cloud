'use client'

// EngagedEvent: sends one Vercel Analytics custom event, "engaged" {via}, once per tab
// session on the first trusted wheel/touch/key input or 3rd pointer move, sent once the
// page has been visible for 1s (earlier input is kept). Headless crawlers rarely produce
// trusted input, so visitors with "engaged" are the trusted-traffic count. Never sent
// under automation (webdriver). The only prop is the input kind: no names, slugs, ids,
// amounts or typed text.

import { useEffect } from 'react'
import { track } from '@vercel/analytics'

export function EngagedEvent() {
  useEffect(() => {
    const send = (name: string, props: Record<string, string>) => {
      try {
        track(name, props)
      } catch {
        /* analytics must never break the page */
      }
    }
    // engaged {via}: once per tab session, the first sign of a real person.
    // Headless crawlers that run JS rarely produce trusted input, so
    // "visitors with engaged" is the trusted-traffic count. Input during the
    // first second is kept and sent once the page has been visible for 1s.
    const ENGAGED_KEY = 'ae_engaged'
    const MIN_VISIBLE_MS = 1000
    let engagedDone = false
    try {
      engagedDone = sessionStorage.getItem(ENGAGED_KEY) === '1'
    } catch {
      /* storage blocked: fall back to once per page load */
    }
    let visibleMs = 0
    let visibleSince = document.visibilityState === 'visible' ? performance.now() : 0
    const visibleFor = () => visibleMs + (visibleSince ? performance.now() - visibleSince : 0)
    const HUMAN_EVENTS = ['pointermove', 'wheel', 'touchstart', 'keydown'] as const
    let moves = 0
    let pendingVia: string | null = null
    let pendingTimer: ReturnType<typeof setTimeout> | undefined
    const tryEngaged = () => {
      clearTimeout(pendingTimer)
      if (engagedDone || !pendingVia) return
      const wait = MIN_VISIBLE_MS - visibleFor()
      if (wait > 0) {
        // Hidden tabs wait for onVisibility to call us again.
        if (document.visibilityState === 'visible') pendingTimer = setTimeout(tryEngaged, wait + 10)
        return
      }
      engagedDone = true
      try {
        sessionStorage.setItem(ENGAGED_KEY, '1')
      } catch {
        /* ignore */
      }
      send('engaged', { via: pendingVia })
      for (const t of HUMAN_EVENTS) window.removeEventListener(t, onHuman, { capture: true })
    }
    const onHuman = (e: Event) => {
      if (engagedDone || pendingVia || !e.isTrusted || navigator.webdriver) return
      if (e.type === 'pointermove' && ++moves < 3) return
      pendingVia = e.type === 'keydown' ? 'key' : e.type === 'touchstart' ? 'touch' : e.type === 'wheel' ? 'wheel' : 'pointer'
      tryEngaged()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (!visibleSince) visibleSince = performance.now()
        tryEngaged()
      } else {
        if (visibleSince) {
          visibleMs += performance.now() - visibleSince
          visibleSince = 0
        }
        clearTimeout(pendingTimer)
      }
    }
    if (!engagedDone) {
      for (const t of HUMAN_EVENTS) window.addEventListener(t, onHuman, { capture: true, passive: true })
      document.addEventListener('visibilitychange', onVisibility)
    }
    return () => {
      clearTimeout(pendingTimer)
      for (const t of HUMAN_EVENTS) window.removeEventListener(t, onHuman, { capture: true })
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
  return null
}

export default EngagedEvent
