.PHONY: dev dev-frontend dev-backend install install-frontend install-backend clean

# Start both frontend and backend concurrently
dev:
	@echo "Starting KINESYS development servers..."
	@make dev-backend & make dev-frontend & wait

dev-frontend:
	cd frontend && npm run dev

dev-backend:
	cd backend && python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

install: install-backend install-frontend

install-frontend:
	cd frontend && npm install

install-backend:
	cd backend && pip install -r requirements.txt

clean:
	rm -rf frontend/node_modules frontend/dist backend/__pycache__ backend/app/__pycache__
