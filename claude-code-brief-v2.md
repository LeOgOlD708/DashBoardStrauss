# MACRO TRADING DASHBOARD — Prompt para Claude Code
## Contexto completo del proyecto

---

## QUIÉN SOY

Angel Lopez (Strauss). Trader en formación con base macro sólida.
- Capital: ~$5K
- Instrumentos: ETFs (SPY, QQQ, GLD, XLE, XLF, TLT, XLB, XLV, XLP, XLU, IWM, GDX) + Micro futuros (MES, MNQ, MGC) — ambos por igual
- Horizonte: Swing trading principalmente, con visión day-trading en entradas
- Objetivo próximo: Challenge FTMO/Topstep en 12-18 meses
- Base intelectual: Michael Howell (CrossBorder Capital), Fidelity AART, Lachmann, The Markets Eye (Diego Puertas), JJ. Montoya

---

## EL PROYECTO

Dashboard web de análisis macro publicado en Vercel.
- URL en vivo: https://dash-board-strauss.vercel.app
- Repo GitHub: https://github.com/LeOgOID708/DashBoardStrauss
- Stack: HTML/CSS/JS puro + Vercel Serverless Functions (Node.js 24)
- Variables de entorno en Vercel: FRED_API_KEY (configurada y funcionando)

---

## ESTADO ACTUAL DEL REPO

```
DashBoardStrauss/
  index.html          ← Dashboard principal (8 pestañas, diseño completo)
  api/
    fred.js           ← FRED API proxy — FUNCIONA ✅
    news.js           ← MarketWatch RSS — funciona parcialmente
    prices.js         ← precios ETFs — NO FUNCIONA (problemas de CORS/API)
  vercel.json         ← {"version": 2}
  package.json        ← {"engines": {"node": "24.x"}}
  claude-code-brief.md ← contexto previo del proyecto
```

---

## OBJETIVO REAL DEL DASHBOARD

**NO es simplemente un monitor de datos.**

Es una herramienta de trading operacional que responde 3 preguntas en tiempo real:
1. ¿En qué fase del ciclo macro estamos? (dirección)
2. ¿Qué catalizadores de timing están activos? (cuándo)
3. ¿Qué dice la estructura técnica del mercado? (confirmación)

**Todo debe ser 100% automático. Cero intervención manual.**
No hay datos de ejemplo. No hay textos hardcodeados que simulen datos reales.
Si un dato no puede obtenerse automáticamente, se muestra "Sin datos" claramente.

---

## REGLAS DE ORO (NO ROMPER)

1. **Todo automático** — nada manual. Si no se puede automatizar, no va.
2. **Sin datos falsos** — cero valores hardcodeados que parezcan datos reales.
3. **Paso a paso y consultando** — antes de redesignar una sección completa, describir el plan y esperar confirmación.
4. **Siempre verificar sintaxis JS** — el bug más común fue un `</script>` faltante que rompía todo el JavaScript silenciosamente.
5. **Hacer commit y push después de cada bloque funcional** — así Vercel redespliega y se puede verificar en vivo.

---

## FRAMEWORK CONCEPTUAL (BASE DE TODO)

### Ciclo de Howell (65 meses — el más importante)
- **Fase 1 — Recuperación:** Equity large caps, tech, bonos largos. DXY débil.
- **Fase 2 — Exceso:** Crypto, small caps, todo equity. La más peligrosa.
- **Fase 3 — Squeeze:** Oro, commodities, value defensivo. DXY subiendo.
- **Fase 4 — Capitulación:** Cash USD, oro, vol larga. DXY disparado.
- **Diagnóstico abril 2026:** Fase 3 → transición a Fase 4

### 4 Indicadores de Diagnóstico (FRED API — ya funcionan)
1. Reservas bancarias Fed (`WRBWFRBL`) — umbral crítico $3.0T
2. Spread SOFR/FFR (`SOFR` + `FEDFUNDS`) — spikes = estrés
3. TGA del Tesoro (`WTREGEN`) — >$1T = drenaje masivo
4. DXY (`DTWEXBGS`) — válvula maestra de liquidez global

### Ciclos complementarios
- **Fidelity:** Early → Mid → Late → Recession (economía real, adelanta 6-9 meses)
- **Inflación:** Monetaria vs CPI (no confundir)
- **China/PBOC:** Fase 1 actualmente — soporte para oro vía Shanghai

---

## LO QUE FUNCIONA BIEN (NO TOCAR)

- Diseño visual completo: oscuro elegante, dorado, IBM Plex Mono + Playfair Display
- FRED API serverless (`/api/fred`) — datos macro en vivo
- Auto-refresh cada 30 minutos
- Estructura de 8 pestañas
- Marca: Angel Lopez (Strauss)
- Vercel deployment estable

---

## LO QUE NECESITA ARREGLARSE / CONSTRUIRSE

### PROBLEMA 1 — Precios ETFs (crítico)
Yahoo Finance bloquea desde servidores (403). FMP free tier solo da SPY.
**Solución verificada:** Yahoo Finance funciona PERFECTAMENTE desde el browser.
Usar `fetch()` directo en `index.html` (no en api/):
```javascript
fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`)
```
ETFs: GLD, GDX, XLE, XLV, XLP, XLU, SPY, QQQ, TLT, XLF, IWM, XLB
VIX: ^VIX, ^VVIX, ^VIX3M

### PROBLEMA 2 — Dashboard necesita rediseño funcional
El diseño actual tiene 8 pestañas pero falta integrar:
- Indicadores técnicos de swing/day trading
- Ventanas embebidas de fuentes externas
- Panel interactivo de decisión

---

## NUEVA ARQUITECTURA PROPUESTA

### Capa 1 — Macro (ya funciona con FRED)
Ciclo de Howell, fase actual, semáforo de indicadores

### Capa 2 — Técnica (nueva — necesita construirse)
Indicadores de timing para swing y day trading.
**Referencias técnicas del trader:**
- **Zcoin** — metodología de análisis técnico que el trader ya utiliza
- **Pro Trading Skills** — framework de trading que el trader ya sigue

Claude Code debe proponer indicadores compatibles con estas metodologías
Y con el contexto de ciclo macro Fase 3/4 de Howell.
Instrumentos: ETFs + Micro futuros (MES, MNQ, MGC) en igual proporción.
Fuente recomendada: widgets embebidos de TradingView (gratuitos, no requieren API)

### Capa 3 — Flujos y Volatilidad (JJ. Montoya framework)
- VIX / VVIX divergencia (señal institucional de cautela)
- Gamma exposure dealers
- CTAs y Vol Control funds
- Fuente: Yahoo Finance browser-side para VIX/VVIX

### Capa 4 — Catalizadores y Noticias
- MarketWatch RSS filtrado por keywords macro
- Geopolítica (Irán, Fed, petróleo, repo)
- Fuente: `/api/news.js` ya existe

---

## FUENTES EXTERNAS A INTEGRAR

Combinación según el contenido:
- **iFrame embebido** para: TradingView charts, The Markets Eye (lectura directa en dashboard)
- **Link con preview** para: Substacks (JJ. Montoya, Capital Wars) que tienen paywall
NO llamar a sus APIs — simplemente embeber su URL o mostrar preview con link.

| Fuente | Qué aporta | URL |
|--------|------------|-----|
| TradingView | Charts técnicos, widgets gratis | tradingview.com/widget |
| The Markets Eye | Síntesis macro Howell en español | themarketseye.com |
| Capital Wars (Howell) | Actualización semanal ciclo GLI | substack |
| JJ. Montoya | VIX/gamma/flujos en español | jjmontoya.substack.com |
| Zcoin | Metodología técnica del trader | Referencia técnica personal |
| Pro Trading Skills | Framework de trading del trader | Referencia técnica personal |
| FRED | Ya integrado vía API | — |

---

## INDICADORES TÉCNICOS SUGERIDOS PARA INVESTIGAR

Para swing trading en ETFs y micro futuros, en contexto de ciclo Fase 3/4:
- Estructura de mercado (highs/lows)
- Momentum: RSI, MACD en timeframe semanal/diario
- Volatilidad: ATR, Bandas de Bollinger
- Flujos: OBV, Volume Profile
- Opciones: Put/Call ratio, VIX term structure
- Macro-técnico: correlación DXY con GLD, correlación SPY con reservas Fed

**Claude Code debe investigar y proponer cuáles son más relevantes para este contexto específico antes de implementar.**

---

## PROCESO DE TRABAJO (IMPORTANTE)

1. Leer este brief completo
2. Auditar el `index.html` y archivos `api/` actuales
3. Proponer un plan de trabajo por fases — esperar aprobación
4. Implementar fase por fase, con commit/push después de cada una
5. Verificar en https://dash-board-strauss.vercel.app después de cada push
6. Si algo no funciona, diagnosticar antes de reescribir

**Empezar siempre por el problema más bloqueante:**
ETF prices (Yahoo Finance browser-side) → cuando eso funcione, el 80% del dashboard funciona.

---

## DISEÑO — RESTRICCIONES

- Mantener el estilo visual actual (oscuro elegante, dorado)
- Colores: bg #07070e, dorado #c9a84c, texto #eae6de
- Fuentes: IBM Plex Mono (datos), Playfair Display (títulos), IBM Plex Sans (cuerpo)
- La interfaz debe ser legible para un trader que conoce el marco macro de Howell
- Interactiva: el trader debe poder navegar rápidamente entre macro, técnico y noticias
- Marca de agua: Angel Lopez (Strauss)

---

## NOTA TÉCNICA CRÍTICA

El `index.html` tiene todo el JavaScript en un bloque `<script>` al final del `<body>`.
**SIEMPRE debe tener un tag `</script>` de cierre antes de `</body>`.**
Si falta ese tag, todo el JavaScript falla silenciosamente — el bug más difícil de detectar del proyecto.

Antes de hacer push, verificar:
```bash
grep -c "</script>" index.html  # debe ser >= 2
```
