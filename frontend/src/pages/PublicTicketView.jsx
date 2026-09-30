import React, { useState, useEffect } from 'react';
import DOMPurify from 'dompurify';
import { IoLockClosedOutline, IoTimeOutline, IoLogInOutline } from 'react-icons/io5';

const sanitizeHtml = (html) => DOMPurify.sanitize(html || '');

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL
    || `${window.location.protocol}//${window.location.hostname}:4000/api`;

const formatDate = (d) => {
    if (!d) return '';
    try {
        return new Date(d).toLocaleString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return d; }
};

// Vista pública de solo lectura de un ticket de Volcán Desk (agregada 2026-08-27,
// a pedido del usuario, para poder compartir/embeber sin exigir sesión). Se monta
// FUERA de todo el shell autenticado de la app (ver App.jsx) — no hay sidebar, no
// hay botones de Responder/Nota/Apoyo, no hay edición de ningún campo. Solo
// funciona con el token exacto emitido por "Copiar enlace público" en
// TicketDetailView.jsx — sin él, /api/public/tickets/:token no encuentra nada.
export default function PublicTicketView({ token, ticketId }) {
    const [ticket, setTicket] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch(`${API_BASE_URL}/public/tickets/${encodeURIComponent(token)}`)
            .then(async (r) => {
                if (!r.ok) {
                    const body = await r.json().catch(() => ({}));
                    throw new Error(body.error || 'No se pudo cargar el ticket.');
                }
                return r.json();
            })
            .then(setTicket)
            .catch((e) => setError(e.message))
            .finally(() => setLoading(false));
    }, [token]);

    return (
        <div style={{ minHeight: '100vh', background: 'var(--color-bg-secondary, #f4f6f8)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ background: '#0f172a', color: '#fff', padding: '14px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontWeight: 700, letterSpacing: 0.3 }}>Volcán Desk</span>
                    <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>· Vista pública de solo lectura</span>
                </div>
                <a
                    href={`/tickets/${encodeURIComponent(ticketId)}`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#3b82f6', color: '#fff', padding: '8px 14px', borderRadius: 6, fontSize: '0.85rem', fontWeight: 600, textDecoration: 'none' }}
                >
                    <IoLogInOutline size={16} /> Iniciar sesión para responder
                </a>
            </div>

            <div style={{ flex: 1, display: 'flex', justifyContent: 'center', padding: '24px 16px' }}>
                <div style={{ width: '100%', maxWidth: 760 }}>
                    {loading && (
                        <div style={{ textAlign: 'center', padding: 60, color: '#64748b' }}>Cargando ticket…</div>
                    )}

                    {!loading && error && (
                        <div style={{ background: '#fff', border: '1px solid #fecaca', borderRadius: 8, padding: 32, textAlign: 'center' }}>
                            <p style={{ color: '#b91c1c', fontWeight: 600, marginBottom: 8 }}>No se pudo mostrar este ticket</p>
                            <p style={{ color: '#64748b', fontSize: '0.9rem' }}>{error}</p>
                            <p style={{ color: '#94a3b8', fontSize: '0.8rem', marginTop: 12 }}>El enlace pudo haber sido revocado, o nunca existió.</p>
                        </div>
                    )}

                    {!loading && !error && ticket && (
                        <>
                            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 24, marginBottom: 16 }}>
                                <div style={{ fontSize: '0.78rem', color: '#94a3b8', marginBottom: 4 }}>#{ticket.id}</div>
                                <h1 style={{ fontSize: '1.4rem', margin: '0 0 10px' }}>{ticket.title}</h1>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
                                    {ticket.status && <span style={{ fontSize: '0.78rem', fontWeight: 600, background: '#eff6ff', color: '#1d4ed8', padding: '3px 10px', borderRadius: 20 }}>{ticket.status}</span>}
                                    {ticket.priority && <span style={{ fontSize: '0.78rem', fontWeight: 600, background: '#fef3c7', color: '#92400e', padding: '3px 10px', borderRadius: 20 }}>{ticket.priority}</span>}
                                    {ticket.category && <span style={{ fontSize: '0.78rem', fontWeight: 600, background: '#f1f5f9', color: '#475569', padding: '3px 10px', borderRadius: 20 }}>{ticket.category}</span>}
                                </div>
                                <div style={{ fontSize: '0.82rem', color: '#64748b', marginBottom: 16 }}>
                                    {ticket.requesterName && <>Solicitante: <strong>{ticket.requesterName}</strong></>}
                                    {ticket.requesterGroupName && <> · {ticket.requesterGroupName}</>}
                                    {ticket.resolverGroupName && <> → <strong>{ticket.resolverGroupName}</strong></>}
                                    {ticket.createdAt && <> · {formatDate(ticket.createdAt)}</>}
                                </div>
                                <div
                                    style={{ borderTop: '1px solid #f1f5f9', paddingTop: 14, color: '#334155', lineHeight: 1.5 }}
                                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(ticket.description) }}
                                />
                            </div>

                            {ticket.comments && ticket.comments.length > 0 && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                    {ticket.comments.map((c) => (
                                        <div key={c.id} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 16px' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                                                <strong style={{ fontSize: '0.85rem' }}>{c.authorName}</strong>
                                                <span style={{ fontSize: '0.72rem', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 4 }}>
                                                    <IoTimeOutline size={12} /> {formatDate(c.createdAt)}
                                                </span>
                                            </div>
                                            <div style={{ color: '#334155', fontSize: '0.9rem', lineHeight: 1.5 }} dangerouslySetInnerHTML={{ __html: sanitizeHtml(c.text) }} />
                                        </div>
                                    ))}
                                </div>
                            )}

                            <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 8, color: '#94a3b8', fontSize: '0.78rem', justifyContent: 'center' }}>
                                <IoLockClosedOutline size={14} /> Vista de solo lectura — las notas internas no se muestran aquí.
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
