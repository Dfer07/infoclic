# InfoClick

Servicio Node que sincroniza CSVs de Cloudflare R2 hacia contactos de HubSpot, con un cron interno.

## Documentación

- **Spec técnico (fuente de verdad)**: [docs/superpowers/specs/2026-05-17-infoclick-design.md](docs/superpowers/specs/2026-05-17-infoclick-design.md)
- **Plan de implementación**: [docs/superpowers/plans/2026-05-17-infoclick-implementation.md](docs/superpowers/plans/2026-05-17-infoclick-implementation.md)
- **CLAUDE.md**: [CLAUDE.md](CLAUDE.md) (índice rápido del proyecto)

## Quick start

```bash
cp .env.example .env
# Editar .env con credenciales reales
npm install
npm run process-once   # corrida puntual
npm start              # cron continuo
```

## Despliegue

```bash
docker compose up -d --build
docker compose logs -f infoclick
```
