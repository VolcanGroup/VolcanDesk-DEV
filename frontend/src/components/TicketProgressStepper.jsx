import { IoCheckmark } from 'react-icons/io5';

// ─── Línea de tiempo de avance (Volcán Desk) ──────────────────────────────
// Los 5 estados de INTERNAL_STATUSES son fijos en código (ver configService.js),
// así que la secuencia y sus colores de "etapa actual" se definen aquí una
// sola vez. Puramente visual: no hay porcentaje, solo completado/actual/pendiente.
const DESK_PROGRESS_STAGES = [
    { id: 'to_do', label: 'Pendiente', color: '#0066CC' },
    { id: 'on_going', label: 'En ejecución', color: '#0066CC' },
    { id: 'in_testing', label: 'Pruebas técnicas', color: '#8b5cf6' },
    { id: 'under_review', label: 'Revisión funcional', color: '#f59e0b' },
    { id: 'done', label: 'Terminado', color: '#10b981' },
];

export default function TicketProgressStepper({ status }) {
    const currentIndex = DESK_PROGRESS_STAGES.findIndex(s => s.id === status);
    // Un ticket bloqueado o con un subestado no listado (no debería pasar, los
    // 5 estados principales son fijos) simplemente no muestra la línea en vez
    // de romper — el subestado/bloqueo ya se ve en la sección Ejecución.
    if (currentIndex === -1) return null;
    return (
        <div className="progress-stepper">
            {DESK_PROGRESS_STAGES.map((stage, idx) => {
                const isDone = idx < currentIndex;
                const isCurrent = idx === currentIndex;
                return (
                    <div key={stage.id} className={`progress-step ${isDone ? 'is-done' : isCurrent ? 'is-current' : 'is-pending'}`}>
                        <div className="progress-step-node">
                            <div
                                className="progress-step-circle"
                                style={isCurrent ? { borderColor: stage.color, boxShadow: `0 0 0 4px ${stage.color}26` } : undefined}
                            >
                                {isDone ? <IoCheckmark size={14} /> : (isCurrent ? <span className="progress-step-dot" style={{ background: stage.color }} /> : null)}
                            </div>
                            {idx < DESK_PROGRESS_STAGES.length - 1 && <div className="progress-step-line" />}
                        </div>
                        <span className="progress-step-label" style={isCurrent ? { color: stage.color } : undefined}>{stage.label}</span>
                    </div>
                );
            })}
        </div>
    );
}
