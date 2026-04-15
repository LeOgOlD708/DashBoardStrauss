# Macro Trading Dashboard — Brief para Claude Code

## Quién soy
Angel Lopez (Strauss). Trader en formación con base macro sólida.
Objetivo: sistema de trading macro funcional → challenge FTMO/Topstep en 12-18 meses.

## El proyecto
Dashboard web de análisis macro publicado en Vercel:
- URL: https://dash-board-strauss.vercel.app
- Repo GitHub: https://github.com/LeOgOID708/DashBoardStrauss (privado)
- Stack: HTML/CSS/JS puro + Vercel Serverless Functions (Node.js)

## Estado actual del repo
```
DashBoardStrauss/
  index.html        ← Dashboard frontend (8 pestañas)
  api/
    fred.js         ← FRED API proxy (FUNCIONANDO)
    news.js         ← MarketWatch RSS (parcialmente)
    prices.js       ← FMP precios ETFs (NO FUNCIONA - 402 en free tier)
  vercel.json       ← {"version": 2}
  package.json      ← {"engines": {"node": "24.x"}}
```

## Variables de entorno en Vercel
- FRED_API_KEY = configurada
- FMP_API_KEY  = configurada (pero el free tier no da ETFs de sectores)

## Lo que funciona
- FRED API: reservas bancarias, SOFR, TGA, DXY, CPI en vivo
- Diseño completo: 8 pestañas, oscuro elegante, marca Angel Lopez (Strauss)
- Auto-refresh cada 30 minutos
- Vercel deployment estable

## Lo que NO funciona y necesita arreglarse

### Problema 1 — Precios ETFs (URGENTE)
Yahoo Finance bloquea requests desde servidores (403).
FMP free tier solo da SPY, no ETFs de sectores (402 en GDX, XLE, GLD, etc.)

ETFs necesarios: GLD, GDX, XLE, XLV, XLP, XLU, SPY, QQQ, TLT, XLF, IWM, XLB

Solución: Yahoo Finance funciona perfectamente desde el browser.
El código en index.html ya tiene fetchYahooVix() que llama a Yahoo directo.
Necesita extenderse para todos los ETFs.

### Problema 2 — VIX/VVIX
^VIX y ^VVIX también son Yahoo Finance.
La función fetchYahooVix() ya existe en index.html pero necesita verificarse.

### Problema 3 — Noticias RSS
api/news.js existe pero necesita prueba en producción.

### Problema 4 — China panel derecho
Algunos campos muestran — en la pestaña DXY & China.

## Arquitectura correcta
- FRED API      → api/fred.js (servidor Vercel) → indicadores Howell
- Yahoo Finance → browser directo               → precios ETFs + VIX
- MarketWatch   → api/news.js (servidor Vercel) → noticias macro

IMPORTANTE: Yahoo bloquea User-Agents de servidores con 403.
Desde el browser funciona perfectamente.

## Framework conceptual
Basado en Michael Howell / CrossBorder Capital:
- Ciclo de liquidez global de 65 meses
- 4 indicadores: Reservas Fed, SOFR/FFR, MOVE Index, TGA
- Diagnóstico actual: Fase 3 → Fase 4 (Abril 2026)

## Las 8 pestañas
1. Diagnóstico — fase del ciclo, activos favorecidos/evitar
2. Indicadores — 4 termómetros Howell con gráficos
3. Activos — heatmap sectorial + tabla ETFs con precios en vivo
4. DXY & China — gauge DXY + métricas PBOC
5. Tesis — horizontes temporal macro
6. Checklist — 7 pasos diagnóstico semanal
7. Volatilidad — VIX/VVIX/Gamma
8. Noticias — feed MarketWatch filtrado

## Prioridad
1. Yahoo Finance browser-side para todos los ETFs (Pestaña 3)
2. VIX/VVIX en vivo (Pestaña 7)
3. China panel derecho (Pestaña 4)
4. Verificar noticias RSS
5. Futuro: Claude API para tesis automáticas

## Diseño
- Fondo: #07070e | Dorado: #c9a84c | Texto: #eae6de
- Fuentes: IBM Plex Mono + Playfair Display + IBM Plex Sans
- Marca: Angel Lopez (Strauss) en footer

## NOTA CRÍTICA DE CÓDIGO
El index.html tiene todo el JS en un bloque script al final del body.
SIEMPRE debe tener un tag </script> de cierre antes de </body>.
Si falta ese tag, todo el JavaScript se rompe silenciosamente.
