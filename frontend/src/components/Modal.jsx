import { IoClose } from 'react-icons/io5';

// `size="large"` — usado por el preview de imagen adjunta (TicketDetailView):
// el modal genérico limita a 600px de ancho, pensado para formularios; una
// captura de pantalla ahí se ve como una miniatura ilegible (reportado en
// vivo 2026-09-08). No se toca `.modal` directo para no afectar el resto de
// los usos (todos formularios que sí se ven bien angostos).
export default function Modal({ isOpen, onClose, title, children, footer, closeOnBackdropClick = true, size }) {
    if (!isOpen) return null;

    const handleBackdropClick = () => {
        if (closeOnBackdropClick) {
            onClose();
        }
    };

    return (
        <div className="modal-backdrop" onClick={handleBackdropClick}>
            <div className={`modal ${size ? `modal-${size}` : ''}`} onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <h2 className="modal-title">{title}</h2>
                    <button className="modal-close" onClick={onClose}>
                        <IoClose size={24} />
                    </button>
                </div>
                <div className="modal-body">
                    {children}
                </div>
                {footer && (
                    <div className="modal-footer">
                        {footer}
                    </div>
                )}
            </div>
        </div>
    );
}
