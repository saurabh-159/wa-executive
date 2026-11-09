from fastapi import Request, HTTPException
from app.models.database import SessionLocal
from app.models.task import Task
from app.services.firebase_auth import verified_tenant_id


def _serialize_task(t: Task) -> dict:
    return {
        "id": t.id,
        "task_heading": t.task_heading,
        "category": t.category,
        "counterparty_name": t.counterparty_name,
        "sender_jid": t.sender_jid,
        "context_their_message": t.context_their_message,
        "context_your_reply": t.context_your_reply,
        "full_thread_summary": t.full_thread_summary,
        "due_date_time": t.due_date_time,
        "priority": t.priority,
        "status": t.status,
    }


# 1. GET ALL TASKS (Filter by category, status, priority)
# Frontend (useTasks) expects a plain JSON array.
async def get_all_tasks(request: Request) -> list:
    params = request.query_params
    category = params.get("category")
    status = params.get("status")
    priority = params.get("priority")

    tenant = verified_tenant_id(request)
    with SessionLocal() as db:
        query = db.query(Task).filter(Task.tenant_jid == tenant)

        if category:
            query = query.filter(Task.category == category)
        if status:
            query = query.filter(Task.status == status)
        if priority:
            query = query.filter(Task.priority == priority)

        tasks = query.order_by(Task.id.desc()).all()
        return [_serialize_task(t) for t in tasks]


# 2. GET TASK STATS / SUMMARY (Dashboard metric counters ke liye)
# Express equivalent: Task.countDocuments({ ... })
async def get_task_stats(request: Request) -> dict:
    tenant = verified_tenant_id(request)
    with SessionLocal() as db:
        scoped = db.query(Task).filter(Task.tenant_jid == tenant)
        total = scoped.count()
        you_owe = (
            db.query(Task)
            .filter(
                Task.tenant_jid == tenant,
                Task.category == "I_OWE_THEM",
                Task.status == "PENDING",
            )
            .count()
        )
        they_owe = (
            db.query(Task)
            .filter(
                Task.tenant_jid == tenant,
                Task.category == "THEY_OWE_ME",
                Task.status == "PENDING",
            )
            .count()
        )
        completed = (
            db.query(Task)
            .filter(Task.tenant_jid == tenant, Task.status == "COMPLETED")
            .count()
        )
        high_priority = (
            db.query(Task)
            .filter(
                Task.tenant_jid == tenant,
                Task.priority == "HIGH",
                Task.status == "PENDING",
            )
            .count()
        )

        return {
            "status": "success",
            "stats": {
                "total": total,
                "you_owe_pending": you_owe,
                "they_owe_pending": they_owe,
                "completed": completed,
                "high_priority_pending": high_priority,
            },
        }


# 3. GET SINGLE TASK BY ID
# Express equivalent: Task.findById(id)
async def get_task_by_id(task_id: int, request: Request) -> dict:
    tenant = verified_tenant_id(request)
    with SessionLocal() as db:
        task = (
            db.query(Task)
            .filter(Task.id == task_id, Task.tenant_jid == tenant)
            .first()
        )
        if not task:
            raise HTTPException(status_code=404, detail="Task nahi mila")

        return {
            "status": "success",
            "data": {
                "id": task.id,
                "task_heading": task.task_heading,
                "category": task.category,
                "counterparty_name": task.counterparty_name,
                "sender_jid": task.sender_jid,
                "context_their_message": task.context_their_message,
                "context_your_reply": task.context_your_reply,
                "full_thread_summary": task.full_thread_summary,
                "due_date_time": task.due_date_time,
                "priority": task.priority,
                "status": task.status,
            },
        }


# 4. UPDATE TASK STATUS (e.g. Mark Done: PENDING -> COMPLETED)
# Express equivalent: Task.findByIdAndUpdate(id, { status })
async def update_task_status(task_id: int, request: Request) -> dict:
    body = await request.json()
    new_status = body.get("status")

    if not new_status:
        raise HTTPException(status_code=400, detail="status field dena zaroori hai")

    tenant = verified_tenant_id(request)
    with SessionLocal() as db:
        task = (
            db.query(Task)
            .filter(Task.id == task_id, Task.tenant_jid == tenant)
            .first()
        )
        if not task:
            raise HTTPException(status_code=404, detail="Task nahi mila")

        task.status = new_status
        db.commit()
        db.refresh(task)

        return {
            "status": "success",
            "message": f"Task #{task_id} status updated to {new_status}",
            "data": {
                "id": task.id,
                "task_heading": task.task_heading,
                "status": task.status,
            },
        }


# 5. CREATE MANUAL TASK (Dashboard UI se agar user khud task add kare)
# Express equivalent: Task.create(req.body)
async def create_manual_task(request: Request) -> dict:
    body = await request.json()

    heading = body.get("task_heading")
    if not heading:
        raise HTTPException(
            status_code=400, detail="task_heading dena zaroori hai"
        )

    tenant = verified_tenant_id(request)
    with SessionLocal() as db:
        new_task = Task(
            task_heading=heading,
            tenant_jid=tenant,
            category=body.get("category", "I_OWE_THEM"),
            counterparty_name=body.get("counterparty_name", "Self"),
            sender_jid=body.get("sender_jid", "manual_entry"),
            context_their_message=body.get("context_their_message", ""),
            context_your_reply=body.get("context_your_reply", ""),
            full_thread_summary=body.get("full_thread_summary", "Manual Entry"),
            due_date_time=body.get("due_date_time", "Pending"),
            priority=body.get("priority", "MEDIUM"),
            status=body.get("status", "PENDING"),
        )
        db.add(new_task)
        db.commit()
        db.refresh(new_task)

        return {
            "status": "success",
            "message": "Task manually created",
            "data": {
                "id": new_task.id,
                "task_heading": new_task.task_heading,
                "category": new_task.category,
                "status": new_task.status,
            },
        }


# 6. DELETE TASK
# Express equivalent: Task.findByIdAndDelete(id)
async def delete_task(task_id: int, request: Request) -> dict:
    tenant = verified_tenant_id(request)
    with SessionLocal() as db:
        task = (
            db.query(Task)
            .filter(Task.id == task_id, Task.tenant_jid == tenant)
            .first()
        )
        if not task:
            raise HTTPException(status_code=404, detail="Task nahi mila")

        db.delete(task)
        db.commit()

        return {
            "status": "success",
            "message": f"Task #{task_id} successfully deleted",
        }