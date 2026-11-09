from app.controllers.tasks_controller import (
    create_manual_task,
    delete_task,
    get_all_tasks,
    get_task_by_id,
    get_task_stats,
    update_task_status,
)
from fastapi import APIRouter, Request

router = APIRouter(prefix="/api/v1/tasks", tags=["Tasks"])


# 1. Summary Stats (Dashboard overview cards ke liye)
@router.get("/stats")
async def tasks_stats_endpoint(request: Request):
    return await get_task_stats(request)


# 2. Saare tasks list karna (Filters support ke sath)
@router.get("")
async def list_tasks_endpoint(request: Request):
    return await get_all_tasks(request)


# 3. Single Task fetch karna
@router.get("/{task_id}")
async def get_task_endpoint(task_id: int, request: Request):
    return await get_task_by_id(task_id, request)


# 4. Status update karna (Mark Done / Complete)
@router.patch("/{task_id}/status")
async def update_status_endpoint(task_id: int, request: Request):
    return await update_task_status(task_id, request)


# 5. Manual task create karna
@router.post("")
async def create_task_endpoint(request: Request):
    return await create_manual_task(request)


# 6. Task delete karna
@router.delete("/{task_id}")
async def delete_task_endpoint(task_id: int, request: Request):
    return await delete_task(task_id, request)