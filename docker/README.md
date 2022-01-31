```text
Developed and tested with:
 pi4 running Raspbian bullseye
 docker version: 20.10.12 (community)
 docker-compose version: 1.29.2

```

## Instructions:

### Build the docker image: 
 > docker-compose build

### Deploy the server in your docker environment:
 > IPADDRESS=192.168.X.X ./start.sh


Replace 192.168.X.X with the IP Address that is used to reach the docker host from your Hub.

Since the docker-compose file uses the default bridge networking and the server needs to be able to tell
the Hub how to contact it, IPAddressOverride is used to set the address reported by the server.


### Stop the server:
 > docker-compose down

### View server logs:
 > docker-compose logs


### Additional Notes:

After building the image, you can move/copy the files from this directory to any location you wish.
The data directory will be mounted in the container and used to persist data between restarts.

