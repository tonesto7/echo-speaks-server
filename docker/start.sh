#!/bin/bash

if [[ (-z "${IPADDRESS}") ]]; then
    echo "Please set IPADDRESS environment variables"
    echo "example: IPADDRESS=192.168.1.100 ./start.sh"
    exit 1
fi

if [ $(grep -c "IPADDRESS_TO_CHANGE" env.echo-speaks-server.dist) -ne 0 ]; then
   sed "s/IPADDRESS_TO_CHANGE/$IPADDRESS/g" env.echo-speaks-server.dist > env.echo-speaks-server
fi

echo "Starting docker-compose"
docker-compose up -d
