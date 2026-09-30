// Constantes compartidas por las páginas de Configuración — extraídas de
// Settings.jsx (2026-09-21) porque SLA_OPTIONS se usaba en 3 componentes
// distintos del mismo archivo.
export const SLA_OPTIONS = [
    { value: 60,    label: '1 hora' },
    { value: 120,   label: '2 horas' },
    { value: 240,   label: '4 horas' },
    { value: 480,   label: '8 horas' },
    { value: 720,   label: '12 horas' },
    { value: 1440,  label: '24 horas' },
    { value: 2880,  label: '48 horas' },
    { value: 10080, label: '7 días' },
    { value: 0,     label: 'Sin límite' },
];

// Tope máximo de pausa por Bloqueo ("Stop SLA") — un ticket puede seguir marcado
// como Bloqueado más tiempo, pero pasado este tope el SLA vuelve a correr solo.
export const BLOQUEO_CAP_OPTIONS = [
    { value: 1440,  label: '1 día' },
    { value: 7200,  label: '5 días' },
    { value: 14400, label: '10 días' },
    { value: 21600, label: '15 días' },
    { value: 28800, label: '20 días' },
    { value: 36000, label: '25 días' },
    { value: 43200, label: '30 días' },
];
