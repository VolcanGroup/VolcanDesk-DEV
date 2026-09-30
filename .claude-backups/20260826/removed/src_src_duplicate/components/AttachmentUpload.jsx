import './AttachmentUpload.css';
import { useState } from 'react';
import { IoCloudUploadOutline, IoTrashOutline, IoDownloadOutline, IoImageOutline } from 'react-icons/io5';
import { createAttachment, downloadAttachment, getFileIcon, formatFileSize, canPreviewImage } from '../services/attachmentService';
import { getCurrentUser } from '../services/authService';

export default function AttachmentUpload({ attachments = [], onAdd, onRemove }) {
    const [isDragging, setIsDragging] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [previewImage, setPreviewImage] = useState(null);
    const currentUser = getCurrentUser();

    const handleDragOver = (e) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = (e) => {
        e.preventDefault();
        setIsDragging(false);
    };

    const handleDrop = async (e) => {
        e.preventDefault();
        setIsDragging(false);

        const files = Array.from(e.dataTransfer.files);
        await handleFiles(files);
    };

    const handleFileSelect = async (e) => {
        const files = Array.from(e.target.files);
        await handleFiles(files);
        e.target.value = ''; // Reset input
    };

    const handleFiles = async (files) => {
        setUploading(true);

        for (const file of files) {
            const attachment = await createAttachment(file, currentUser.id);
            if (attachment && onAdd) {
                onAdd(attachment);
            }
        }

        setUploading(false);
    };

    const handleRemove = (attachmentId) => {
        if (onRemove) {
            onRemove(attachmentId);
        }
    };

    const handleDownload = (attachment) => {
        downloadAttachment(attachment);
    };

    const handlePreview = (attachment) => {
        if (canPreviewImage(attachment.fileType)) {
            setPreviewImage(attachment);
        }
    };

    return (
        <div className="attachment-upload">
            <div
                className={`upload-zone ${isDragging ? 'dragging' : ''}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                <IoCloudUploadOutline size={32} />
                <p>Arrastra archivos aquí o haz clic para seleccionar</p>
                <input
                    type="file"
                    multiple
                    onChange={handleFileSelect}
                    disabled={uploading}
                />
                {uploading && <p className="uploading">Subiendo archivos...</p>}
            </div>

            {attachments.length > 0 && (
                <div className="attachments-list">
                    <h4>Archivos adjuntos ({attachments.length})</h4>
                    {attachments.map(attachment => (
                        <div key={attachment.id} className="attachment-item">
                            <span className="file-icon">{getFileIcon(attachment.fileType)}</span>
                            <div className="file-info">
                                <span className="file-name">{attachment.fileName}</span>
                                <span className="file-size">{formatFileSize(attachment.fileSize)}</span>
                            </div>
                            <div className="file-actions">
                                {canPreviewImage(attachment.fileType) && (
                                    <button
                                        className="btn-icon"
                                        onClick={() => handlePreview(attachment)}
                                        title="Vista previa"
                                    >
                                        <IoImageOutline size={18} />
                                    </button>
                                )}
                                <button
                                    className="btn-icon"
                                    onClick={() => handleDownload(attachment)}
                                    title="Descargar"
                                >
                                    <IoDownloadOutline size={18} />
                                </button>
                                <button
                                    className="btn-icon btn-danger"
                                    onClick={() => handleRemove(attachment.id)}
                                    title="Eliminar"
                                >
                                    <IoTrashOutline size={18} />
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Image Preview Modal */}
            {previewImage && (
                <div className="preview-modal" onClick={() => setPreviewImage(null)}>
                    <div className="preview-content" onClick={(e) => e.stopPropagation()}>
                        <img src={previewImage.fileData} alt={previewImage.fileName} />
                        <button className="close-preview" onClick={() => setPreviewImage(null)}>×</button>
                    </div>
                </div>
            )}
        </div>
    );
}
