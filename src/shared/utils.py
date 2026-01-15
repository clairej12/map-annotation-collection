import json
import os
import pdb

# MAPS_DIR = "/maps/"
# OBSERVATIONS_DIR = "/observations/"
# ROUTES_FILE = "../route-creation/routes_windy_Pittsburgh_Pennsylvania_USA.json"
# IMAGES_FILE = "../route-creation/img-mapped-routes-Pittsburgh_Pennsylvania_USA.json" # "../route-creation/img_metadata.json"
# # LANDMARKS_FILE = ""

# def parse_routes():
#     data_list = {}
#     data = {
#         "route_id": None,
#         "observations": [],
#         "landmarks": [],
#         "endpoints": []
#     }

#     with open(ROUTES_FILE, "r") as f:
#         routes_data = json.load(f)
#     with open(IMAGES_FILE, "r") as f:
#         images_data = json.load(f)
    
#     landmarks_dict = {}
#     # with open(LANDMARKS_FILE, "r") as f:
#     #     landmarks_data = json.load(f)
#     #     landmarks_dict = {route["route_id"]: route["landmarks"] for route in landmarks_data}
    
#     for i, route in enumerate(routes_data):
#         route_id = route["route_id"]
#         images = images_data[i]["path"]
#         # images = images_data[route_id]

#         data["route_id"] = route_id
#         data["map"] = os.path.join(MAPS_DIR, f"route_{route_id}.png")
#         data["observations"] = [os.path.join(
#                                     OBSERVATIONS_DIR,
#                                     f'{img["pano_id"]}_{img["pano_heading"]}.jpg')
#                                 for img in images]
#         # data["observations"] = [os.path.join(
#         #                             OBSERVATIONS_DIR,
#         #                             route_id,
#         #                             f'{img["id"]}.jpg')
#         #                         for img in images]
#         data["landmarks"] = landmarks_dict.get(route_id, []) + ["Start (S)", "End (G)", "Endpoint 1", "Endpoint 2", "Endpoint 3"]
#         data["endpoints"] = route.get("endpoints", [])

#         data_list[route_id]=data

#         data = {
#             "route_id": None,
#             "observations": [],
#             "landmarks": [],
#             "endpoints": []
#         }

#     return data_list


MAPS_DIR = "/maps/"
OBSERVATIONS_DIR = "/observations/"
ROUTES_FILE = "/home/claireji/napkin-map/route_creation_jacob/routes_with_endpoint_markers.json"
# LANDMARKS_FILE = "../MapDataCollection/data/landmarks.json"
# route_ids = [10983,4085,2394,11661,9944,4881,5837,5163,3017,2804,9758,4546,7950,2648,5487,1086,2183,8624,8592,8505,5105,11455,7035,6316,9675,8473,8153,9089,9146,4159,8987,4765,9648,5501,1400,299,8262,10232,385,11502,3209,9968,7139,9733,9434,713,3304,8379,6895,2289,9159,31,3536,6485,2342,1835,9091,2468,3846,6094,5428,2167]

def parse_routes():
    data_list = {}
    data = {
        "route_id": None,
        "observations": [],
        "landmarks": [],
        "endpoints": []
    }

    with open(ROUTES_FILE, "r") as f:
        routes_data = json.load(f)
    
    # with open(LANDMARKS_FILE, "r") as f:
    #     landmarks_data = json.load(f)
    #     landmarks_dict = {route["route_id"]: route["landmarks"] for route in landmarks_data}
    
    for route in routes_data:
        route_id = route["route_id"]
        data["route_id"] = str(route_id)
        data["map"] = os.path.join(MAPS_DIR, f"{route_id}.png")
        data["observations"] = [os.path.join(
                                    OBSERVATIONS_DIR,
                                    r["image_id"])
                                for r in route["lat_lng_path"]]
        data["landmarks"] = ["Start (S)", "End (G)", "Point A", "Point B", "Point C"] # landmarks_dict[route_id] + 
        data["endpoints"] = [em["label"] for em in route.get("endpoint_markers", [])]

        data_list[str(route_id)]=data

        data = {
            "route_id": None,
            "observations": [],
            "landmarks": [],
            "endpoints": []
        }

    return data_list

