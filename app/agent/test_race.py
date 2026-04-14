import asyncio

todos = []

async def add_todo(title):
    # Simulates state.add_todo behavior
    new_id = len(todos)
    await asyncio.sleep(0.001)  # Simulate async work
    todos.append({'title': title, 'id': new_id})

async def test():
    tasks = [add_todo(f'Task {i}') for i in range(10)]
    await asyncio.gather(*tasks)
    print(f'Expected 10 todos with IDs 0-9')
    print(f'Got {len(todos)} todos')
    ids = [t['id'] for t in todos]
    print(f'IDs: {ids}')
    if len(set(ids)) < len(ids):
        print('RACE CONDITION: Duplicate IDs found!')
    else:
        print('No duplicate IDs (but order may vary)')

asyncio.run(test())
