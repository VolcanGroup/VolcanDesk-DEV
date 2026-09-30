import React, { useState, useEffect, useRef } from 'react';
import { IoNotificationsOutline, IoClose, IoTicket, IoCheckmarkDone } from 'react-icons/io5';
import { getNotifications, markAllRead, markRead, clearNotification } from '../services/notificationService';
import { formatRelativeTime } from '../utils/helpers';

export default function NotificationInbox({ currentUser, onNavigateToTicket }) {
    const [open, setOpen] = useState(false);
    const [notifications, setNotifications] = useState([]);
    const [unread, setUnread] = useState(0);
    const panelRef = useRef(null);

    // getNotifications/markRead/etc. ahora hablan con el servidor (ver
    // notificationService.js), así que dejan de ser síncronas.
    const refresh = async () => {
        if (!currentUser) return;
        const notifs = await getNotifications();
        setNotifications(notifs);
        setUnread(notifs.filter(n => !n.read).length);
    };

    useEffect(() => {
        refresh();
        const interval = setInterval(refresh, 3000); // Poll every 3s
        return () => clearInterval(interval);
    }, [currentUser]);

    // Close on click outside
    useEffect(() => {
        const handler = (e) => {
            if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
        };
        if (open) document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    const handleOpen = () => {
        setOpen(o => !o);
    };

    const handleMarkAllRead = async () => {
        await markAllRead();
        refresh();
    };

    const handleClick = async (notif) => {
        await markRead(notif.id);
        refresh();
        setOpen(false);
        onNavigateToTicket?.(notif.ticketId);
    };

    return (
        <div style={{ position: 'relative' }} ref={panelRef}>
            <button
                onClick={handleOpen}
                style={{
                    position: 'relative',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--color-text-secondary)',
                    padding: '6px',
                    borderRadius: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    width: 'auto',
                    transition: 'all 0.2s'
                }}
                title="Notificaciones"
            >
                <IoNotificationsOutline size={22} />
                {unread > 0 && (
                    <span style={{
                        position: 'absolute',
                        top: 0, right: 0,
                        background: 'var(--color-error)',
                        color: 'white',
                        borderRadius: '10px',
                        fontSize: '10px',
                        fontWeight: 'bold',
                        padding: '1px 5px',
                        minWidth: '16px',
                        textAlign: 'center',
                        lineHeight: '14px',
                        pointerEvents: 'none'
                    }}>
                        {unread > 9 ? '9+' : unread}
                    </span>
                )}
            </button>

            {open && (
                <div style={{
                    position: 'absolute',
                    right: 0,
                    top: '40px',
                    width: '360px',
                    background: 'var(--color-bg-secondary)',
                    border: '1px solid var(--glass-border)',
                    borderRadius: 'var(--radius-lg)',
                    boxShadow: 'var(--shadow-lg)',
                    zIndex: 9999,
                    overflow: 'hidden'
                }}>
                    {/* Header */}
                    <div style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '12px 16px',
                        borderBottom: '1px solid var(--glass-border)',
                        background: 'var(--color-bg-primary)'
                    }}>
                        <strong style={{ color: 'var(--color-text-primary)', fontSize: '0.95rem' }}>
                            🔔 Notificaciones {unread > 0 && <span style={{ color: 'var(--color-primary-light)' }}>({unread})</span>}
                        </strong>
                        {unread > 0 && (
                            <button
                                onClick={handleMarkAllRead}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-primary-light)', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '4px', width: 'auto', padding: '4px 8px' }}
                            >
                                <IoCheckmarkDone size={14}/> Marcar todo leído
                            </button>
                        )}
                    </div>

                    {/* List */}
                    <div style={{ maxHeight: '380px', overflowY: 'auto' }}>
                        {notifications.length === 0 ? (
                            <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: '0.875rem' }}>
                                Sin notificaciones pendientes
                            </div>
                        ) : notifications.map(n => (
                            <div
                                key={n.id}
                                onClick={() => handleClick(n)}
                                style={{
                                    padding: '12px 16px',
                                    borderBottom: '1px solid var(--glass-border)',
                                    cursor: 'pointer',
                                    background: n.read ? 'transparent' : 'rgba(139,92,246,0.07)',
                                    display: 'flex',
                                    gap: '12px',
                                    alignItems: 'flex-start',
                                    transition: 'background 0.15s'
                                }}
                                onMouseEnter={e => e.currentTarget.style.background = 'var(--color-bg-hover)'}
                                onMouseLeave={e => e.currentTarget.style.background = n.read ? 'transparent' : 'rgba(139,92,246,0.07)'}
                            >
                                <div style={{
                                    width: 32, height: 32, borderRadius: '50%', background: 'var(--gradient-primary)',
                                    color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    fontWeight: 'bold', fontSize: '0.8rem', flexShrink: 0
                                }}>
                                    {(n.fromUser?.name || '?').substring(0, 2).toUpperCase()}
                                </div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: '0.85rem', color: 'var(--color-text-primary)', marginBottom: '2px' }}>
                                        <strong>{n.fromUser?.name}</strong> {n.message}
                                    </div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', display: 'flex', gap: '8px', alignItems: 'center' }}>
                                        <IoTicket size={12}/> {n.ticketTitle}
                                        <span>· {formatRelativeTime(n.createdAt)}</span>
                                    </div>
                                </div>
                                {!n.read && (
                                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-primary)', flexShrink: 0, marginTop: 6 }} />
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
