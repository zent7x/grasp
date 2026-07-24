import os


def migrate():
    path = os.path.join(os.getcwd(), 'data')
    if not os.path.exists(path):
        os.makedirs(path)
    return path
