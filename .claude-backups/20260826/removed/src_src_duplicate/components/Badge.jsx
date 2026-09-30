export default function Badge({ children, variant = 'primary', size = 'md', style }) {
    return (
        <span className={`badge badge-${variant} ${size === 'sm' ? 'badge-sm' : ''}`} style={style}>
            {children}
        </span>
    );
}
