import './Kanban.css';
import { useState, useEffect } from 'react';
import { IoAddOutline, IoGridOutline, IoListOutline, IoCalendarOutline } from 'react-icons/io5';
import { getTickets, createTicket, updateTicket, addComment, addAttachment, removeAttachment } from '../services/ticketService';
import { getUsers, getUserById } from '../services/userService';
import { getCurrentUser } from '../services/authService';
import { formatRelativeTime } from '../utils/helpers';
import Modal from '../components/Modal';
import Badge from '../components/Badge';
import AttachmentUpload from '../components/AttachmentUpload';

export default function Kanban() {
    const [tickets, setTickets] = useState([]);
    const [users, setUsers] = useState([]);
    const [view, setView] = useState('board'); // board, list, calendar
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [selectedCard, setSelectedCard] = useState(null);
    const [newComment, setNewComment] = useState('');
    const [draggedTicket, setDraggedTicket] = useState(null);
    const currentUser = getCurrentUser();

    const statuses = ['new', 'in progress', 'resolved', 'closed'];

    useEffect(() => {
        refreshTickets();
        setUsers(getUsers());
    }, []);

    const refreshTickets = () => {
        setTickets(getTickets());
    };

    const getTicketsByStatus = (status) => {
        return tickets.filter(t => t.status === status);
    };

    const handleDragStart = (e, ticket) => {
        setDraggedTicket(ticket);
        e.dataTransfer.effectAllowed = 'move';
    };

    const handleDragOver = (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    };

    const handleDrop = (e, newStatus) => {
        e.preventDefault();
        if (draggedTicket && draggedTicket.status !== newStatus) {
            updateTicket(draggedTicket.id, { status: newStatus });
            refreshTickets();
        }
        setDraggedTicket(null);
    };

    const handleCreateTicket = (e) => {
        e.preventDefault();
        const formData = new FormData(e.target);
        createTicket({
            title: formData.get('title'),
            description: formData.get('description'),
            priority: formData.get('priority'),
            assignedTo: formData.get('assignedTo') || null,
            createdBy: currentUser.id,
        });
        setShowCreateModal(false);
        refreshTickets();
        e.target.reset();
    };

    const handleUpdateStatus = (ticketId, newStatus) => {
        updateTicket(ticketId, { status: newStatus });
        refreshTickets();
        if (selectedCard && selectedCard.id === ticketId) {
            setSelectedCard(getTickets().find(t => t.id === ticketId));
        }
    };

    const handleAddComment = (ticketId) => {
        if (newComment.trim()) {
            addComment(ticketId, currentUser.id, newComment);
            setNewComment('');
            refreshTickets();
            setSelectedCard(getTickets().find(t => t.id === ticketId));
        }
    };

    const handleAddAttachment = (ticketId, attachment) => {
        addAttachment(ticketId, attachment);
        refreshTickets();
        setSelectedCard(getTickets().find(t => t.id === ticketId));
    };

    const handleRemoveAttachment = (ticketId, attachmentId) => {
        removeAttachment(ticketId, attachmentId);
        refreshTickets();
        setSelectedCard(getTickets().find(t => t.id === ticketId));
    };

    const getPriorityColor = (priority) => {
        const colors = {
            low: 'var(--color-priority-low)',
            medium: 'var(--color-priority-medium)',
            high: 'var(--color-priority-high)',
            urgent: 'var(--color-priority-urgent)'
        };
        return colors[priority] || 'var(--color-text-muted)';
    };

    const getUserName = (userId) => {
        if (!userId) return 'Sin asignar';
        const user = getUserById(userId);
        return user ? user.name : 'Sin asignar';
    };

    const statusLabels = {
        'new': 'Nuevo',
        'in progress': 'En Progreso',
        'resolved': 'Resuelto',
        'closed': 'Cerrado'
    };

    return (
        <div className="kanban-page">
            <div className="kanban-header">
                <div>
                    <h1>Tablero Kanban</h1>
                    <p className="text-muted">Gestiona tus proyectos visualmente</p>
                </div>
                <div className="kanban-actions">
                    <div className="view-switcher">
                        <button
                            className={`view-btn ${view === 'board' ? 'active' : ''}`}
                            onClick={() => setView('board')}
                        >
                            <IoGridOutline />
                        </button>
                        <button
                            className={`view-btn ${view === 'list' ? 'active' : ''}`}
                            onClick={() => setView('list')}
                        >
                            <IoListOutline />
                        </button>
                        <button
                            className={`view-btn ${view === 'calendar' ? 'active' : ''}`}
                            onClick={() => setView('calendar')}
                        >
                            <IoCalendarOutline />
                        </button>
                    </div>
                    <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
                        <IoAddOutline size={20} />
                        Nueva Tarea
                    </button>
                </div>
            </div>

            {view === 'board' && (
                <div className="kanban-board">
                    {statuses.map(status => (
                        <div
                            key={status}
                            className="kanban-column"
                            onDragOver={handleDragOver}
                            onDrop={(e) => handleDrop(e, status)}
                        >
                            <div className="column-header">
                                <h3>{statusLabels[status]}</h3>
                                <span className="column-count">{getTicketsByStatus(status).length}</span>
                            </div>
                            <div className="column-cards">
                                {getTicketsByStatus(status).map(ticket => (
                                    <div
                                        key={ticket.id}
                                        className="kanban-card"
                                        draggable
                                        onDragStart={(e) => handleDragStart(e, ticket)}
                                        onClick={() => setSelectedCard(ticket)}
                                        style={{ borderLeftColor: getPriorityColor(ticket.priority) }}
                                    >
                                        <div className="kanban-card-header">
                                            <span className="card-id">#{ticket.id}</span>
                                            <Badge variant="primary" size="sm">{ticket.priority}</Badge>
                                        </div>
                                        <h4>{ticket.title}</h4>
                                        <p>{ticket.description}</p>
                                        <div className="card-footer">
                                            <span className="card-assignee">{getUserName(ticket.assignedTo)}</span>
                                            {(ticket.comments?.length > 0 || ticket.attachments?.length > 0) && (
                                                <div className="card-meta">
                                                    {ticket.comments?.length > 0 && (
                                                        <span>💬 {ticket.comments.length}</span>
                                                    )}
                                                    {ticket.attachments?.length > 0 && (
                                                        <span>📎 {ticket.attachments.length}</span>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {view === 'list' && (
                <div className="kanban-list">
                    <table className="kanban-table">
                        <thead>
                            <tr>
                                <th>Título</th>
                                <th>Estado</th>
                                <th>Prioridad</th>
                                <th>Asignado</th>
                                <th>Fecha</th>
                            </tr>
                        </thead>
                        <tbody>
                            {tickets.map(ticket => (
                                <tr key={ticket.id}>
                                    <td>{ticket.title}</td>
                                    <td><Badge variant="info">{statusLabels[ticket.status]}</Badge></td>
                                    <td><Badge variant="warning">{ticket.priority}</Badge></td>
                                    <td>{getUserName(ticket.assignedTo)}</td>
                                    <td>{formatRelativeTime(ticket.createdAt)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {view === 'calendar' && (
                <div className="kanban-calendar">
                    <div className="calendar-grid">
                        {Array.from({ length: 30 }, (_, i) => {
                            const date = new Date();
                            date.setDate(date.getDate() - 15 + i);
                            const dayTickets = tickets.filter(t => {
                                const ticketDate = new Date(t.createdAt);
                                return ticketDate.toDateString() === date.toDateString();
                            });

                            return (
                                <div key={i} className="calendar-day">
                                    <div className="calendar-date">{date.getDate()}</div>
                                    {dayTickets.map(ticket => (
                                        <div
                                            key={ticket.id}
                                            className="calendar-ticket"
                                            style={{ borderLeftColor: getPriorityColor(ticket.priority) }}
                                        >
                                            {ticket.title}
                                        </div>
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Create Modal */}
            <Modal
                isOpen={showCreateModal}
                onClose={() => setShowCreateModal(false)}
                title="Nueva Tarea"
            >
                <form onSubmit={handleCreateTicket}>
                    <div className="input-group">
                        <label>Título *</label>
                        <input type="text" name="title" required />
                    </div>
                    <div className="input-group">
                        <label>Descripción *</label>
                        <textarea name="description" required rows="3" />
                    </div>
                    <div className="input-group">
                        <label>Prioridad</label>
                        <select name="priority" defaultValue="medium">
                            <option value="low">Baja</option>
                            <option value="medium">Media</option>
                            <option value="high">Alta</option>
                            <option value="urgent">Urgente</option>
                        </select>
                    </div>
                    <div className="input-group">
                        <label>Asignar a</label>
                        <select name="assignedTo">
                            <option value="">Sin asignar</option>
                            {users.filter(u => u.role === 'admin' || u.role === 'agent').map(user => (
                                <option key={user.id} value={user.id}>{user.name}</option>
                            ))}
                        </select>
                    </div>
                    <div className="modal-footer" style={{ padding: 0, border: 'none', marginTop: 'var(--spacing-lg)' }}>
                        <button type="button" className="btn btn-secondary" onClick={() => setShowCreateModal(false)}>
                            Cancelar
                        </button>
                        <button type="submit" className="btn btn-primary">
                            Crear
                        </button>
                    </div>
                </form>
            </Modal>

            {/* Card Detail Modal */}
            <Modal
                isOpen={!!selectedCard}
                onClose={() => setSelectedCard(null)}
                title={selectedCard?.title || ''}
            >
                {selectedCard && (
                    <div className="card-detail">
                        <div className="card-detail-header">
                            <span className="card-id-large">#{selectedCard.id}</span>
                            <div className="card-detail-badges">
                                <Badge variant="info">{statusLabels[selectedCard.status]}</Badge>
                                <Badge variant="warning">{selectedCard.priority}</Badge>
                            </div>
                        </div>

                        <div className="card-detail-info">
                            <p><strong>Descripción:</strong></p>
                            <p>{selectedCard.description}</p>
                            <p className="text-muted">Creado {formatRelativeTime(selectedCard.createdAt)}</p>
                        </div>

                        <div className="card-detail-actions">
                            <div className="action-group">
                                <label>Estado:</label>
                                <select
                                    value={selectedCard.status}
                                    onChange={(e) => handleUpdateStatus(selectedCard.id, e.target.value)}
                                >
                                    <option value="new">Nuevo</option>
                                    <option value="in progress">En Progreso</option>
                                    <option value="resolved">Resuelto</option>
                                    <option value="closed">Cerrado</option>
                                </select>
                            </div>
                            <div className="action-group">
                                <label>Asignado a:</label>
                                <select
                                    value={selectedCard.assignedTo || ''}
                                    onChange={(e) => { updateTicket(selectedCard.id, { assignedTo: e.target.value || null }); refreshTickets(); setSelectedCard(getTickets().find(t => t.id === selectedCard.id)); }}
                                >
                                    <option value="">Sin asignar</option>
                                    {users.filter(u => u.role === 'admin' || u.role === 'agent').map(user => (
                                        <option key={user.id} value={user.id}>{user.name}</option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        <div className="card-comments">
                            <h4>Comentarios ({selectedCard.comments?.length || 0})</h4>
                            <div className="comments-list">
                                {selectedCard.comments?.map(comment => (
                                    <div key={comment.id} className="comment">
                                        <strong>{getUserName(comment.userId)}</strong>
                                        <span className="text-muted text-sm">{formatRelativeTime(comment.createdAt)}</span>
                                        <p>{comment.text}</p>
                                    </div>
                                ))}
                            </div>
                            <div className="add-comment">
                                <textarea
                                    placeholder="Añadir un comentario..."
                                    value={newComment}
                                    onChange={(e) => setNewComment(e.target.value)}
                                    rows="3"
                                />
                                <button
                                    className="btn btn-primary btn-sm"
                                    onClick={() => handleAddComment(selectedCard.id)}
                                >
                                    Añadir Comentario
                                </button>
                            </div>
                        </div>

                        <AttachmentUpload
                            attachments={selectedCard.attachments || []}
                            onAdd={(attachment) => handleAddAttachment(selectedCard.id, attachment)}
                            onRemove={(attachmentId) => handleRemoveAttachment(selectedCard.id, attachmentId)}
                        />
                    </div>
                )}
            </Modal>
        </div>
    );
}
