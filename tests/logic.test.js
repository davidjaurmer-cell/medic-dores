/* Pruebas unitarias del motor de reglas de MEDIC-DORES.
   Ejecutar desde la raíz del repositorio:  node tests/logic.test.js
   No necesita dependencias: extrae el <script> del motor (window.Logic) desde index.html
   y lo ejecuta en un contexto aislado de Node (vm). */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script>(\/\* Motor de reglas[\s\S]*?)<\/script>/);
if (!m) throw new Error('No se encontró el motor de reglas en index.html');
const ctx = { module: { exports: {} } };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(m[1], ctx);
const L = ctx.module.exports;

let ok = 0, fail = 0;
function test(nombre, fn) {
  try { fn(); ok++; console.log('  ✓ ' + nombre); }
  catch (e) { fail++; console.log('  ✗ ' + nombre + '\n      ' + e.message); }
}

// ---------- datos de prueba (ficticios) ----------
const HDR = ['Estado Int', 'No Caso', 'C', 'D', 'E', 'F', 'Vigencia Desde', 'Vigencia Hasta', 'I', 'J', 'K', 'L', 'M', 'No Prescripcion',
  'F Actualizacion', 'Ultima Actualizacion', 'EPS', 'Tipo Id', 'Id Paciente'];
const caso = n => '1234567890202601' + String(n).padStart(10, '0');
function fila({ estado = 'Para Gestión', n, desde = '2026-11-01', hasta = '2026-11-30', presc = '', fAct = '2026-11-10 07:00:00', eps = 'EPS AURORA', doc = '' }) {
  const r = new Array(HDR.length).fill('');
  r[0] = estado; r[1] = caso(n); r[6] = desde; r[7] = hasta; r[13] = presc; r[14] = fAct; r[15] = '1000'; r[16] = eps;
  if (doc) { r[17] = 'CC'; r[18] = doc; }
  return r;
}
const config = () => { const c = L.defaultConfig(); return c; };
const equipo = [{ id: 'a', nombre: 'Ana' }, { id: 'b', nombre: 'Beto' }];

console.log('\nFechas y festivos');
test('Domingo de Pascua 2026 = 5 de abril', () => assert.equal(L.easter(2026), '2026-04-05'));
test('Colombia tiene 18 festivos en 2026', () => assert.equal(L.colombianHolidays(2026).length, 18));
test('Reyes Magos 2026 se corre al lunes 12 de enero (Ley Emiliani)', () =>
  assert.ok(L.colombianHolidays(2026).some(h => h.date === '2026-01-12' && h.name === 'Reyes Magos')));
test('Sábado, domingo y festivo no son días hábiles', () => {
  const c = config();
  assert.equal(L.isBusinessDay('2026-11-07', c), false);
  assert.equal(L.isBusinessDay('2026-11-08', c), false);
  assert.equal(L.isBusinessDay('2026-11-02', c), false); // Todos los Santos (corrido)
  assert.equal(L.isBusinessDay('2026-11-10', c), true);
});
test('parseDate acepta dd/mm/aaaa con a. m./p. m., ISO, dd-MMM-aa y serial de Excel', () => {
  assert.equal(L.parseDate('10/11/2026 2:30 p. m.').ts, '2026-11-10 14:30:00');
  assert.equal(L.parseDate('2026-11-10T07:05:09').ts, '2026-11-10 07:05:09');
  assert.equal(L.parseDate('10-nov-26').day, '2026-11-10');
  assert.equal(L.parseDate('46336').day, '2026-11-10');
  assert.equal(L.parseDate('no es fecha'), null);
});

console.log('\nNúmero de caso');
test('Detecta un No Caso dañado por Excel (notación científica)', () => assert.equal(L.cleanCase('1.23457E+25').status, 'danado'));
test('Limpia apóstrofo, espacios y ".0"', () => {
  assert.equal(L.cleanCase("'1234 5678").caso, '12345678');
  assert.equal(L.cleanCase('987654.0').caso, '987654');
});

console.log('\nLectura del historial');
test('Ubica columnas por encabezado y clasifica PBS / NO PBS', () => {
  const h = L.parseHistorial([HDR, fila({ n: 1, presc: '2026111000123' }), fila({ n: 2 }), fila({ n: 2 })]);
  assert.equal(h.registros.length, 2);
  assert.equal(h.stats.duplicados, 1);
  assert.equal(h.registros[0].tipo, 'NO PBS');
  assert.equal(h.registros[1].tipo, 'PBS');
});
test('Falla con mensaje claro si faltan columnas obligatorias', () =>
  assert.throws(() => L.parseHistorial([['Columna X'], ['1']]), /faltan columnas/));

console.log('\nMañana: depuración y reparto');
const FECHA = '2026-11-10';
function plan(filas, novedades = [], cfg = config()) {
  const hist = L.parseHistorial([HDR, ...filas]);
  return L.planMorning({ fecha: FECHA, hist, novedades, activos: equipo, config: cfg, yaAsignados: new Map(), yaGrupos: new Map() });
}
test('Aplica cada regla de exclusión con su motivo', () => {
  const p = plan([
    fila({ n: 1 }),                                            // se asigna
    fila({ n: 2, eps: 'EPS ORIÓN S.A.' }),                     // EPS no gestionada
    fila({ n: 3, hasta: '2026-11-05' }),                       // vencido sin novedad → alto riesgo
    fila({ n: 4 }),                                            // con novedad
    fila({ n: 5, desde: '2026-11-20' }),                       // vigencia futura
    fila({ n: 6, estado: 'Autorizado' }),                      // no es candidato
  ], [{ caso: caso(4), fecha: '2026-11-09', fuente: 'EPS Aurora' }]);
  const mot = Object.fromEntries(p.excluidos.map(e => [e.caso.slice(-1), e.motivo]));
  assert.equal(p.resumen.candidatos, 5);
  assert.equal(p.casos.length, 1);
  assert.equal(mot['2'], 'Excluido: EPS no gestionada');
  assert.equal(mot['3'], 'Excluido: vencido');
  assert.equal(mot['4'], 'Excluido: ya tenía novedad');
  assert.equal(mot['5'], 'Excluido: vigencia futura');
  assert.equal(p.altoRiesgo.length, 1);
});
test('Destino sugerido: Gestión Posterior si la vigencia supera los días configurados', () => {
  const p = plan([fila({ n: 1, estado: 'Direccionamientos', hasta: '2027-01-30' }), fila({ n: 2, estado: 'Direccionamientos', hasta: '2026-11-20' })]);
  const d = Object.fromEntries(p.casos.map(c => [c.caso.slice(-1), c.destino]));
  assert.equal(d['1'], 'Gestión Posterior');
  assert.equal(d['2'], 'Para Gestión');
});
test('Reparto equitativo: 10 casos entre 2 personas quedan 5 y 5', () => {
  const p = plan(Array.from({ length: 10 }, (_, i) => fila({ n: i + 1 })));
  assert.deepEqual([p.resumen.porPersona.a, p.resumen.porPersona.b], [5, 5]);
});
test('Los casos de un mismo paciente van a la misma persona', () => {
  const p = plan([fila({ n: 1, doc: '80000001' }), fila({ n: 2, doc: '80000001' }), fila({ n: 3, doc: '80000001' }), fila({ n: 4 }), fila({ n: 5 })]);
  const dueños = new Set(p.casos.filter(c => +c.caso.slice(-1) <= 3).map(c => c.asignado));
  assert.equal(dueños.size, 1);
  assert.ok(!JSON.stringify(p).includes('80000001'), 'no debe guardar el documento del paciente');
});

test('Alerta "por vencer": vence hoy (0) y en 2 días hábiles; no marca los lejanos', () => {
  // 2026-11-10 es martes: el jueves 12 está a 2 días hábiles
  const p = plan([fila({ n: 1, hasta: '2026-11-10' }), fila({ n: 2, hasta: '2026-11-12' }), fila({ n: 3, hasta: '2026-11-30' })]);
  const c = Object.fromEntries(p.casos.map(x => [x.caso.slice(-1), x]));
  assert.equal(c['1'].porVencer, true); assert.equal(c['1'].diasHabilesVence, 0);
  assert.equal(c['2'].porVencer, true); assert.equal(c['2'].diasHabilesVence, 2);
  assert.ok(!c['3'].porVencer);
  assert.equal(p.resumen.porVencer, 2);
});

console.log('\nRedistribución por ausencia');
test('Pasa los pendientes de la persona ausente y le deja los que ya gestionó', () => {
  const eq3 = [{ id: 'a', nombre: 'Ana' }, { id: 'b', nombre: 'Beto' }, { id: 'c', nombre: 'Caro' }];
  const hist = L.parseHistorial([HDR, ...Array.from({ length: 9 }, (_, i) => fila({ n: i + 1 }))]);
  const p = L.planMorning({ fecha: FECHA, hist, novedades: [], activos: eq3, config: config(), yaAsignados: new Map(), yaGrupos: new Map() });
  const tanda = { id: FECHA, fecha: FECHA, tanda: 1, activos: p.activos, casos: p.casos, excluidos: [] };
  const deA = p.casos.filter(c => c.asignado === 'a').map(c => c.caso);
  // la persona "a" ya movió su primer caso: con el historial actual se queda con ella
  const actual = L.parseHistorial([HDR, ...p.casos.map(c => fila({ n: +c.caso.slice(-10), estado: c.caso === deA[0] ? 'Autorizado' : 'Para Gestión' }))]);
  const r = L.redistribuir({ tandas: [tanda], de: 'a', para: ['b', 'c'], hist: actual, motivo: 'Ausencia: Permiso', config: config() });
  assert.equal(r.seQuedan.length, 1);
  assert.equal(r.movidos.length, deA.length - 1);
  assert.equal(tanda.casos.filter(c => c.asignado === 'a').length, 1);
  assert.ok(r.movidos.every(m => m.a === 'b' || m.a === 'c'));
  const movido = tanda.casos.find(c => c.caso === r.movidos[0].caso);
  assert.equal(movido.reasignaciones[0].tipo, 'ausencia');
});
test('Sin personas que reciban, no mueve nada y explica el error', () => {
  const r = L.redistribuir({ tandas: [], de: 'a', para: [], motivo: 'x', config: config() });
  assert.match(r.error, /al menos una persona/);
});

console.log('\nCierre e indicador');
test('Clasifica cambio de estado, novedad del día, sin cambio y no aparece', () => {
  const pm = plan([fila({ n: 1 }), fila({ n: 2 }), fila({ n: 3 }), fila({ n: 4 })]);
  const dia = { fecha: FECHA, fotoTs: '2026-11-10 07:30:00', casos: pm.casos, activos: pm.activos, excluidos: pm.excluidos };
  const hc = L.parseHistorial([HDR,
    fila({ n: 1, estado: 'Autorizado', fAct: '2026-11-10 10:00:00' }),   // cambio después de la foto
    fila({ n: 2 }),                                                     // sin cambio, con novedad del día
    fila({ n: 3 }),                                                     // sin cambio
  ]);
  const c = L.computeClose({ dia, hist: hc, novedades: [{ caso: caso(2), fecha: FECHA, fuente: 'Manual' }], config: config() });
  const r = n => c.resultados[caso(n)].resultado;
  assert.equal(r(1), L.RES.PROPIO);
  assert.equal(r(2), L.RES.NOVEDAD);
  assert.equal(r(3), L.RES.NO);
  assert.equal(r(4), L.RES.NO);
  assert.equal(c.resultados[caso(4)].motivo, 'No aparece en el historial');

  dia.cierre = c;
  const agg = L.aggregate(L.flatten([dia]), config());
  assert.equal(agg.team.asignados, 4);
  assert.equal(agg.team.gestionados, 2);
  assert.equal(agg.team.pct, 50);
});
test('Un cambio anterior a la foto de la mañana no cuenta', () => {
  const pm = plan([fila({ n: 1 })]);
  const dia = { fecha: FECHA, fotoTs: '2026-11-10 07:30:00', casos: pm.casos };
  const hc = L.parseHistorial([HDR, fila({ n: 1, estado: 'Autorizado', fAct: '2026-11-10 06:00:00' })]);
  const c = L.computeClose({ dia, hist: hc, novedades: [], config: config() });
  assert.equal(c.resultados[caso(1)].resultado, L.RES.NO);
});
test('Un caso quitado de la asignación no cuenta en la base del indicador', () => {
  const pm = plan([fila({ n: 1 }), fila({ n: 2 })]);
  const dia = { fecha: FECHA, fotoTs: null, casos: pm.casos };
  dia.cierre = L.computeClose({ dia, hist: L.parseHistorial([HDR, fila({ n: 1, estado: 'Autorizado' }), fila({ n: 2 })]), novedades: [], config: config() });
  L.quitarCasos(dia, [caso(2)], 'Error en la asignación', 'prueba');
  const agg = L.aggregate(L.flatten([dia]), config());
  assert.equal(agg.team.asignados, 1);
  assert.equal(agg.team.pct, 100);
});
test('Marca manual "Gestionado" convierte un No gestionado y se puede deshacer', () => {
  const pm = plan([fila({ n: 1 })]);
  const dia = { fecha: FECHA, fotoTs: null, casos: pm.casos, marcas: { [caso(1)]: { tipo: 'gestionado', obs: 'llamada' } } };
  const c = L.computeClose({ dia, hist: L.parseHistorial([HDR, fila({ n: 1 })]), novedades: [], config: config() });
  assert.equal(c.resultados[caso(1)].resultado, L.RES.PROPIO);
  dia.marcas = {}; L.aplicarMarcas(dia, c);
  assert.equal(c.resultados[caso(1)].resultado, L.RES.NO);
});

console.log('\nGenerador de PDF (MiniPDF)');
test('Genera un PDF válido con texto en español y figuras', () => {
  const mp = html.match(/<script>(\/\* Generador de PDF[\s\S]*?)<\/script>/);
  const c2 = { module: { exports: {} } }; c2.self = c2; vm.createContext(c2); vm.runInContext(mp[1], c2);
  const P = c2.module.exports, d = P.create();
  d.page(); d.text('Informe de productividad · cumplimiento 82,5 %', 40, 40, { size: 12, bold: true }); d.rect(40, 60, 120, 20, { fill: '#0e9e8b' });
  const bytes = d.output({ title: 'Prueba' });
  const txt = Buffer.from(bytes).toString('latin1');
  assert.ok(txt.startsWith('%PDF-1.4'));
  assert.ok(txt.trimEnd().endsWith('%%EOF'));
  assert.match(txt, /\/Type\s*\/Page\b/);
});

console.log(`\n${ok} pruebas correctas, ${fail} fallidas.\n`);
process.exit(fail ? 1 : 0);
