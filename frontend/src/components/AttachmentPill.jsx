import { IoAttachOutline } from 'react-icons/io5';

// Adjunto de un mensaje/comentario: {id, name, dataUrl, type: 'image'|'file', size}
// (ver RichTextEditor.jsx). Una imagen (pegada como captura o subida) se puede
// previsualizar con un click sin descargar nada — antes cualquier adjunto,
// imagen o no, solo abría el diálogo de "Guardar archivo" (reportado en vivo
// 2026-09-08). Un archivo que no es imagen no tiene vista previa útil, así que
// mantiene el comportamiento de descarga directa.
export default function AttachmentPill({ att, onDownload, onPreview, onClickCapture }) {
    const isImage = att.type === 'image' && !!att.dataUrl;
    if (isImage) {
        return (
            <div
                className="attachment-pill attachment-pill-image"
                onClick={(e) => { onClickCapture?.(e); onPreview(att); }}
                title="Ver imagen"
            >
                <img src={att.dataUrl} alt={att.name} className="attachment-thumb" />
                <span>{att.name}</span>
            </div>
        );
    }
    return (
        <div
            className="attachment-pill"
            onClick={(e) => { onClickCapture?.(e); onDownload(att); }}
            title="Descargar"
        >
            <IoAttachOutline size={14} /><span>{att.name}</span>
        </div>
    );
}
